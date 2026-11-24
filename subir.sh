#!/bin/bash
cd ~/Área\ de\ trabalho/amora3
git add .
git commit -m "atualização $(date +%d-%m-%Y_%H:%M)"
git push origin main
echo "--- SUBIU PRO 【entity-GITHUB¦canonical_name=GitHub】 ---"
