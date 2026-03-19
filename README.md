# AGMysnow - GW Travel

Agente de automação para cotação de viagens. Recebe dados do cliente via formulário, pesquisa hotéis no Mysnow TAAP, coleta reviews, gera relatório HTML e envia por e-mail.

## Estrutura

```
├── frontend/
│   ├── intake.html          # Formulário de entrada
│   ├── confirmacao.html     # Tela pós-submit
│   └── assets/
│       └── styles.css
├── src/
│   ├── server.js            # Servidor Express
│   ├── agent.js             # Orquestrador principal
│   ├── mysnow-scraper.js    # Automação Mysnow TAAP (Puppeteer)
│   ├── review-fetcher.js    # Busca reviews TripAdvisor/Mysnow
│   ├── report-generator.js  # Gera relatório HTML
│   └── email-sender.js      # Envia e-mail com link
├── templates/
│   ├── report-template.html
│   └── email-template.html
├── outputs/                 # Relatórios gerados
├── .env.example
├── package.json
└── README.md
```

## Setup

1. Copie `.env.example` para `.env` e configure as variáveis
2. Instale as dependências:

```bash
npm install
```

3. Inicie o servidor:

```bash
npm start
```

4. Acesse `http://localhost:3000`

## Configuração

Veja `.env.example` para todas as variáveis necessárias:

- **Mysnow TAAP**: Credenciais de login
- **E-mail**: Resend API ou SMTP (Gmail, etc.)
- **WhatsApp**: Número para botão de contato
- **Servidor**: Porta e URL base

## Fluxo

1. Cliente preenche formulário com destino, datas, preferências
2. Servidor recebe dados via POST `/api/cotacao`
3. Agente busca hotéis no Mysnow TAAP
4. Reviews são coletados do TripAdvisor e Mysnow público
5. 3 opções são selecionadas (3, 4 e 5 estrelas)
6. Relatório HTML é gerado em `/outputs/`
7. E-mail com link para o relatório é enviado ao cliente
