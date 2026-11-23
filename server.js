const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 80;

// Configurações do Bunny.net Storage & CDN
const BUNNY_STORAGE_ENDPOINT = process.env.BUNNY_STORAGE_ENDPOINT || 'https://br.storage.bunnycdn.com/amora3';
const BUNNY_CDN_URL = process.env.BUNNY_CDN_URL || 'https://amora3.b-cdn.net';
const BUNNY_ACCESS_KEY = process.env.BUNNY_ACCESS_KEY || 'dbc547d7-7576-4101-8365bfebf525-af69-4740';

// Upload em MEMÓRIA (as fotos nunca tocam no disco da VPS!)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // limite 10MB
});

// Configuração do Banco de Dados PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'amora3_db',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'amora3_admin',
  password: process.env.DB_PASSWORD || 'Amora3_Secret_Db_2026!',
  database: process.env.DB_NAME || 'amora3',
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos (páginas HTML, logos, etc.)
app.use(express.static(path.join(__dirname)));

// ──────────────────────────────────────────────────────────
// ROTA: Upload de Foto DIRETO para o Bunny.net (Sem salvar na VPS)
// ──────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    }

    const fileExt = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const folder = req.body.folder === 'avatars' ? 'avatars' : 'posts';
    const fileName = `${folder}/${uuidv4()}${fileExt}`;
    const uploadUrl = `${BUNNY_STORAGE_ENDPOINT}/${fileName}`;

    // Envia direto da memória para o Bunny Storage no Brasil
    const bunnyRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_ACCESS_KEY,
        'Content-Type': req.file.mimetype || 'application/octet-stream'
      },
      body: req.file.buffer
    });

    const cdnUrl = `${BUNNY_CDN_URL}/${fileName}`;
    return res.status(201).json({
      success: true,
      url: cdnUrl,
      fileName
    });
  } catch (err) {
    console.error('Erro no upload Bunny:', err);
    return res.status(500).json({ error: 'Erro interno durante o upload.' });
  }
});

// Lista de Gestos Aleatórios Anti-Fake
const GESTURES = [
  { id: 'paz', icon: '✌️', text: 'Sinal da Paz (dois dedos em V)', tip: 'Posicione a mão ao lado do rosto e sorria' },
  { id: 'joinha', icon: '👍', text: 'Polegar para Cima (Joinha)', tip: 'Posicione o joinha próximo ao queixo' },
  { id: 'tres_dedos', icon: '🤟', text: 'Três dedos levantados', tip: 'Mostre 3 dedos ao lado da bochecha' },
  { id: 'palma_aberta', icon: '🖐️', text: 'Palma da mão aberta', tip: 'Coloque a palma da mão ao lado do rosto' },
  { id: 'ok', icon: '👌', text: 'Sinal de OK (círculo com dedos)', tip: 'Posicione o sinal de OK na altura do ombro' }
];

// Rota: Sortear Gesto do Desafio Anti-Fake
app.get('/api/verification/challenge', (req, res) => {
  const randomIndex = Math.floor(Math.random() * GESTURES.length);
  const challenge = GESTURES[randomIndex];
  res.json({
    challengeId: uuidv4(),
    gesture: challenge
  });
});

// Rota: Envio do Vídeo de Verificação (direto pro Bunny Storage)
app.post('/api/verification/upload', upload.single('video'), async (req, res) => {
  try {
    const { userId, gestureCode } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum vídeo de verificação foi enviado.' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'Identificação de usuário necessária.' });
    }

    const fileExt = path.extname(req.file.originalname).toLowerCase() || '.webm';
    const fileName = `verificacoes/${userId}_${uuidv4()}${fileExt}`;
    const uploadUrl = `${BUNNY_STORAGE_ENDPOINT}/${fileName}`;

    // Envia o vídeo direto da memória para o Bunny Storage
    const bunnyRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_ACCESS_KEY,
        'Content-Type': req.file.mimetype || 'video/webm'
      },
      body: req.file.buffer
    });

    if (!bunnyRes.ok) {
      const errText = await bunnyRes.text();
      console.error('Erro Bunny Storage Verificação:', errText);
      return res.status(500).json({ error: 'Erro ao transferir vídeo de verificação para o Bunny Storage.' });
    }

    const videoUrl = `${BUNNY_CDN_URL}/${fileName}`;

    // Registra no banco de dados na fila de moderação pendente do Admin
    await pool.query(
      `INSERT INTO verifications (user_id, video_url, gesture_code, status)
       VALUES ($1, $2, $3, 'pending')`,
      [userId, videoUrl, gestureCode || 'gesto_3s']
    );

    return res.status(201).json({
      success: true,
      message: 'Vídeo recebido! Ele foi enviado para a moderação e seu Selo Verificado será liberado assim que aprovado.',
      isVerified: false
    });
  } catch (err) {
    console.error('Erro no upload de verificação:', err);
    return res.status(500).json({ error: 'Erro ao processar verificação anti-fake.' });
  }
});

// ──────────────────────────────────────────────────────────
// ROTAS DO PAINEL DO ADMINISTRADOR (ADMIN)
// ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AmoraAdmin@2026!';
const adminTokens = new Set(['amora3_master_session_token']);

// Middleware de autenticação de admin
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Acesso não autorizado ao painel admin.' });
  }
  const token = authHeader.split(' ')[1];
  if (!adminTokens.has(token)) {
    return res.status(401).json({ error: 'Sessão administrativa expirada ou inválida.' });
  }
  next();
}

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = 'admin_' + uuidv4();
    adminTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Senha administrativa incorreta.' });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const pendingVerif = await pool.query("SELECT COUNT(*) FROM verifications WHERE status = 'pending'");
    const verifiedUsers = await pool.query('SELECT COUNT(*) FROM users WHERE is_verified = TRUE');
    const postsCount = await pool.query('SELECT COUNT(*) FROM posts');
    return res.json({
      totalUsers: parseInt(usersCount.rows[0].count),
      pendingVerifications: parseInt(pendingVerif.rows[0].count),
      verifiedUsers: parseInt(verifiedUsers.rows[0].count),
      totalPosts: parseInt(postsCount.rows[0].count)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// GET /api/admin/verifications
app.get('/api/admin/verifications', requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT v.id, v.user_id, v.video_url, v.gesture_code, v.status, v.notes, v.created_at, v.reviewed_at,
             u.nickname, u.email, u.profile_type, u.is_verified,
             p.city, p.uf
      FROM verifications v
      JOIN users u ON u.id = v.user_id
      LEFT JOIN profiles p ON p.user_id = u.id
    `;
    const params = [];
    if (status && status !== 'all') {
      query += ` WHERE v.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY CASE WHEN v.status = 'pending' THEN 1 ELSE 2 END, v.created_at DESC LIMIT 50`;

    const result = await pool.query(query, params);
    return res.json({ verifications: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar verificações.' });
  }
});

// POST /api/admin/verifications/:id/approve
app.post('/api/admin/verifications/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const verifRes = await pool.query('SELECT user_id FROM verifications WHERE id = $1', [id]);
    if (verifRes.rows.length === 0) return res.status(404).json({ error: 'Verificação não encontrada.' });

    const userId = verifRes.rows[0].user_id;
    await pool.query("UPDATE verifications SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
    await pool.query('UPDATE users SET is_verified = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);

    return res.json({ success: true, message: 'Verificação aprovada! Selo liberado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao aprovar.' });
  }
});

// POST /api/admin/verifications/:id/reject
app.post('/api/admin/verifications/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const verifRes = await pool.query('SELECT user_id FROM verifications WHERE id = $1', [id]);
    if (verifRes.rows.length === 0) return res.status(404).json({ error: 'Verificação não encontrada.' });

    const userId = verifRes.rows[0].user_id;
    await pool.query("UPDATE verifications SET status = 'rejected', notes = $2, reviewed_at = CURRENT_TIMESTAMP WHERE id = $1", [id, reason || 'Gesto incorreto ou vídeo escuro']);
    await pool.query('UPDATE users SET is_verified = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);

    return res.json({ success: true, message: 'Verificação rejeitada.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao rejeitar.' });
  }
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nickname, u.email, u.profile_type, u.is_verified, u.is_founder, u.created_at,
             p.city, p.uf, p.views_count,
             (SELECT COUNT(*) FROM posts WHERE user_id = u.id) AS posts_count
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      ORDER BY u.created_at DESC LIMIT 100
    `);
    return res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao listar usuários.' });
  }
});

// POST /api/admin/users/:id/toggle-verified
app.post('/api/admin/users/:id/toggle-verified', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const userRes = await pool.query('SELECT is_verified FROM users WHERE id = $1', [id]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const newStatus = !userRes.rows[0].is_verified;
    await pool.query('UPDATE users SET is_verified = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStatus, id]);

    return res.json({ success: true, is_verified: newStatus });
  } catch (err) {
    console.error('Erro ao alternar selo:', err);
    res.status(500).json({ error: 'Erro ao alterar status de verificado.' });
  }
});

// Redireciona /admin para admin.html
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ──────────────────────────────────────────────────────────
// ROTA: Cadastro de Membro (POST /api/register)
// ──────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      nickname,
      email,
      password,
      profileType,
      city,
      uf,
      seekingCasais,
      seekingMulheres,
      seekingHomens,
      hideDistance,
      statusPhrase,
      bio,
      firstPost
    } = req.body;

    if (!nickname || !email || !password || !profileType || !city) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    const cleanNick = nickname.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const cleanEmail = email.toLowerCase().trim();

    await client.query('BEGIN');

    const nickCheck = await client.query('SELECT id FROM users WHERE LOWER(nickname) = $1', [cleanNick]);
    if (nickCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este nome de usuário (nickname) já está em uso.' });
    }

    const emailCheck = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este e-mail já está cadastrado.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userRes = await client.query(
      `INSERT INTO users (nickname, email, password_hash, profile_type, is_verified, is_founder)
       VALUES ($1, $2, $3, $4, FALSE, TRUE)
       RETURNING id, nickname, email, profile_type, is_founder, created_at`,
      [cleanNick, cleanEmail, passwordHash, profileType]
    );
    const newUser = userRes.rows[0];

    await client.query(
      `INSERT INTO profiles 
        (user_id, status_phrase, bio, uf, city, hide_distance, seeking_casais, seeking_mulheres, seeking_homens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        newUser.id,
        statusPhrase || null,
        bio || null,
        uf || 'SP',
        city.trim(),
        hideDistance !== false,
        seekingCasais !== false,
        seekingMulheres !== false,
        seekingHomens === true
      ]
    );

    if (firstPost && firstPost.trim().length > 0) {
      await client.query(
        `INSERT INTO posts (user_id, content, is_blurred, watermark_enabled)
         VALUES ($1, $2, FALSE, TRUE)`,
        [newUser.id, firstPost.trim()]
      );
    }

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Cadastro realizado com sucesso!',
      user: {
        id: newUser.id,
        nickname: newUser.nickname,
        email: newUser.email,
        profileType: newUser.profile_type,
        isFounder: newUser.is_founder
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro no cadastro:', err);
    return res.status(500).json({ error: 'Erro interno ao processar cadastro. Tente novamente.' });
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────────────────
// ROTA: Obter Perfil e Postagens (GET /api/profile/:nickname)
// ──────────────────────────────────────────────────────────
app.get('/api/profile/:nickname', async (req, res) => {
  try {
    const { nickname } = req.params;
    const cleanNick = nickname.toLowerCase().trim();

    const userRes = await pool.query(
      `SELECT u.id, u.nickname, u.profile_type, u.is_verified, u.is_founder, u.created_at,
              p.status_phrase, p.bio, p.uf, p.city, p.seeking_casais, p.seeking_mulheres, p.seeking_homens,
              p.views_count, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE LOWER(u.nickname) = $1`,
      [cleanNick]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'Perfil não encontrado.' });
    }

    const profileData = userRes.rows[0];

    const postsRes = await pool.query(
      `SELECT id, content, media_url, is_blurred, watermark_enabled, likes_count, comments_count, created_at
       FROM posts
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [profileData.id]
    );

    return res.json({
      profile: profileData,
      posts: postsRes.rows
    });
  } catch (err) {
    console.error('Erro ao buscar perfil:', err);
    return res.status(500).json({ error: 'Erro ao buscar dados do perfil.' });
  }
});

// ──────────────────────────────────────────────────────────
// ROTA: Criar Nova Postagem com ou sem Foto (POST /api/posts)
// ──────────────────────────────────────────────────────────
app.post('/api/posts', async (req, res) => {
  try {
    const { userId, content, mediaUrl, isBlurred } = req.body;
    if (!userId || (!content && !mediaUrl)) {
      return res.status(400).json({ error: 'Conteúdo ou imagem obrigatória.' });
    }

    const postRes = await pool.query(
      `INSERT INTO posts (user_id, content, media_url, is_blurred, watermark_enabled)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [userId, (content || '').trim(), mediaUrl || null, isBlurred === true]
    );

    return res.status(201).json({ success: true, post: postRes.rows[0] });
  } catch (err) {
    console.error('Erro ao criar postagem:', err);
    return res.status(500).json({ error: 'Erro ao criar postagem.' });
  }
});

// Rota de status do servidor
app.get('/api/health', async (req, res) => {
  try {
    const dbTest = await pool.query('SELECT NOW()');
    res.json({
      status: 'online',
      database: 'connected',
      bunnyStorage: 'configured (br.storage.bunnycdn.com)',
      bunnyCdn: BUNNY_CDN_URL,
      time: dbTest.rows[0].now
    });
  } catch (err) {
    res.status(500).json({ status: 'online', database: 'disconnected', error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AMORA3 Server com Bunny Storage rodando na porta ${PORT}`);
});
