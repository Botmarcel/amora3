// Passo 3 vem aqui: fetch para http://localhost:4000
const API='http://localhost:4000';
async function signup(dados){ const r=await fetch(API+'/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(dados)}); return r.json(); }
