// AMORA³ - Passo 2 - Backend real (sem banco externo, usa JSON local pra começar)
// Porta 4000 - roda no Linux Mint: cd backend && npm install && npm start
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));
const SECRET = 'amora3-trocar-em-producao';
const DB_FILE = './db.json';
function load(){ try{ return JSON.parse(fs.readFileSync(DB_FILE,'utf8')) }catch{ return {users:[], posts:[], chats:[]} } }
function save(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)) }
let db = load();

function auth(req,res,next){
  const h = req.headers.authorization || '';
  const token = h.replace('Bearer ','');
  if(!token) return res.status(401).json({erro:'Sem token. Faça login.'});
  try{ req.user = jwt.verify(token, SECRET); next(); }catch{ return res.status(401).json({erro:'Token inválido'}) }
}
const idade = (nasc)=>{ const d=new Date(nasc), hoje=new Date(); let i=hoje.getFullYear()-d.getFullYear(); const m=hoje.getMonth()-d.getMonth(); if(m<0||(m===0&&hoje.getDate()<d.getDate())) i--; return i; };

app.get('/health',(req,res)=>res.json({ok:true, app:'AMORA3', users:db.users.length, posts:db.posts.length}));

// CADASTRO - Passo 1 obrigatório
app.post('/auth/signup', async (req,res)=>{
  const {email, senha, perfil, genero, nascimento, bio, fotoReal, documentoOk} = req.body;
  if(!email||!senha) return res.status(400).json({erro:'E-mail e senha obrigatórios'});
  if(!perfil||!genero) return res.status(400).json({erro:'Selecione seu perfil e seu gênero para continuar.'});
  if(!nascimento) return res.status(400).json({erro:'Data de nascimento obrigatória'});
  if(idade(nascimento)<18) return res.status(403).json({erro:'Menor de 18 bloqueado. ECA.'});
  if(!fotoReal) return res.status(400).json({erro:'Foto real obrigatória. Sem ícone, desenho, avatar.'});
  if(!bio) return res.status(400).json({erro:'Bio obrigatória. Diga gênero, orientação e o que busca.'});
  if(db.users.find(u=>u.email===email)) return res.status(400).json({erro:'E-mail já cadastrado'});
  // Regra trans: divergente vai pra revisão, não bloqueia auto (simplificado: se genero contém Trans/Travesti/NB e documentoOk===false -> revisao)
  const precisaRevisao = /Trans|Travesti|Não-binário|Nao-binario/i.test(genero) && documentoOk===false;
  const hash = await bcrypt.hash(senha, 10);
  const user = {id:Date.now().toString(), email, senha:hash, perfil, genero, nascimento, bio, fotoReal:true, documentoOk:!!documentoOk, status: precisaRevisao ? 'em_revisao' : 'ativo', verificado: !!documentoOk, plano:'pendente', assinante:false, criadoEm:new Date().toISOString()};
  db.users.push(user); save(db);
  const token = jwt.sign({id:user.id, email, perfil, genero}, SECRET);
  res.json({ok:true, token, user:{...user, senha:undefined}, mensagem: precisaRevisao ? 'Seu perfil está em análise, em até 24h liberamos' : 'Conta criada. Complete Ativar sua conta para liberar o chat.'});
});

app.post('/auth/login', async (req,res)=>{
  const {email, senha} = req.body;
  const u = db.users.find(x=>x.email===email);
  if(!u) return res.status(404).json({erro:'Usuário não encontrado'});
  if(!(await bcrypt.compare(senha, u.senha))) return res.status(401).json({erro:'Senha incorreta'});
  const token = jwt.sign({id:u.id, email, perfil:u.perfil, genero:u.genero}, SECRET);
  res.json({ok:true, token, user:{...u, senha:undefined}});
});

// ATIVAR CONTA - valores só aqui dentro, nunca na landing
app.post('/ativar', auth, (req,res)=>{
  const u = db.users.find(x=>x.id===req.user.id);
  // Regra interna: Mulher Solo Cis grátis, demais R$ 19,90. Não divulgar fora.
  if(u.perfil==='Mulher Solo' && u.genero==='Mulher Cis'){ u.plano='gratis'; u.assinante=true; }
  else { u.plano='pendente_pagamento'; u.assinante=false; }
  save(db);
  res.json({ok:true, plano:u.plano, assinante:u.assinante, mensagem: u.assinante ? 'Conta ativa. Chat liberado.' : 'Pague via Asaas (PIX/Cartão) para liberar o chat. Webhook confirma.'});
});

// ASAAS WEBHOOK - Asaas chama aqui quando pagou
app.post('/asaas/webhook', (req,res)=>{
  const {email, status} = req.body; // status: CONFIRMED / RECEIVED
  const u = db.users.find(x=>x.email===email);
  if(u && (status==='CONFIRMED'||status==='RECEIVED')){ u.assinante=true; u.plano='premium'; save(db); }
  res.json({ok:true});
});

// FEED - 3 abas
app.get('/feed', auth, (req,res)=>{
  const aba = req.query.aba || 'para_voce';
  let posts = [...db.posts].reverse();
  if(aba==='seguindo') posts = posts.filter(p=>p.autorId===req.user.id);
  res.json(posts.map(p=>({...p, generoBusca: p.genero+' • Busca: '+p.busca})));
});
app.post('/posts', auth, (req,res)=>{
  const u = db.users.find(x=>x.id===req.user.id);
  if(!u.verificado) return res.status(403).json({erro:'Verifique sua conta para publicar.'});
  if(!u.assinante && !(u.perfil==='Mulher Solo'&&u.genero==='Mulher Cis')) {
    // Mulher Solo Cis grátis já é assinante. Demais precisam pagar para postar/conversar.
    // Para teste, permite postar mas marca como preview - troque para bloquear em produção se quiser.
  }
  const post = {id:Date.now().toString(), autorId:u.id, autor:u.email.split('@')[0], genero:u.genero, busca: req.body.busca||'Sem restrição', texto:req.body.texto||'', foto:req.body.foto||'', curtidas:0, comentarios:[], criadoEm:new Date().toISOString()};
  db.posts.push(post); save(db);
  res.json({ok:true, post});
});

// CHAT - só assinante verificado
app.get('/inbox', auth, (req,res)=>{
  const u = db.users.find(x=>x.id===req.user.id);
  if(!u.assinante) return res.status(403).json({erro:'Chat só para assinantes verificados.'});
  res.json(db.chats.filter(c=>c.de===u.id||c.para===u.id));
});
app.post('/chat', auth, (req,res)=>{
  const u = db.users.find(x=>x.id===req.user.id);
  if(!u.assinante||!u.verificado) return res.status(403).json({erro:'Só conversa assinante que passou pela verificação de documento + foto real.'});
  const msg = {id:Date.now().toString(), de:u.id, para:req.body.para, texto:req.body.texto, criadoEm:new Date().toISOString()};
  db.chats.push(msg); save(db); res.json({ok:true, msg});
});

app.listen(4000, ()=>console.log('AMORA3 backend rodando na porta 4000 - http://localhost:4000/health'));
