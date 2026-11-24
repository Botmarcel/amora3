# AMORA³ - Passo 2 - Backend real

## 1 comando para rodar (no PC, Linux Mint)
cd ~/Área\ de\ trabalho/amora3/backend
npm install
npm start
# Vai aparecer: AMORA3 backend rodando na porta 4000

## Testar no navegador
http://localhost:4000/health
Tem que aparecer: {"ok":true,"app":"AMORA3"...}

## Testar cadastro (no terminal, ou no VS Code)
curl -X POST http://localhost:4000/auth/signup -H "Content-Type: application/json" -d '{"email":"teste@teste.com","senha":"123456","perfil":"Casal","genero":"Homem Cis","nascimento":"1990-01-01","bio":"Casal, buscamos...","fotoReal":true,"documentoOk":true}'

Se faltar perfil/genero -> erro "Selecione seu perfil e seu gênero"
Se menor de 18 -> bloqueado
Se trans + documentoOk false -> status em_revisao

## Próximos passos (um por vez)
Passo 3: ligar frontend com esse backend (fetch)
Passo 4: Asaas webhook real
Passo 5: deploy EasyPanel / KingHost
