@echo off
rem Wrapper que o Chrome executa. Repassa stdin/stdout binarios ao Node.
rem Nao imprima NADA aqui: qualquer byte extra corrompe o protocolo.
node "%~dp0remux-host.js"
