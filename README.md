# Casa das Ofertas — Kit Halteres Ajustável 6 em 1

Página de produto + checkout próprio (PIX via ZuckPay).

## 1. Coloque as fotos do produto

Salve as 7 imagens do produto em `public/img/` com estes nomes exatos:

```
public/img/produto-1.jpg   -> mulher fazendo flexão com a alça kettlebell
public/img/produto-2.jpg   -> "3 modos de kettlebell"
public/img/produto-3.jpg   -> "haltere para barra" (peso leve / pesado)
public/img/produto-4.jpg   -> kit completo em fundo branco  (usada no checkout)
public/img/produto-5.jpg   -> "treinamento muscular"
public/img/produto-6.jpg   -> homem segurando o haltere (foto 2KG)
public/img/produto-7.jpg   -> halteres + kettlebell + barras
```

Sem isso as imagens aparecem quebradas — o resto do site funciona normalmente.

## 2. Instale e rode

```bash
cd C:\Users\leale\casa-das-ofertas
npm install
copy .env.example .env
npm start
```

Abra http://localhost:3000

Sem credenciais no `.env` o site roda em **modo simulado**: o checkout funciona
inteiro, mas o código PIX gerado é falso (serve só para testar o visual).

## 3. Ligue a ZuckPay de verdade

1. No painel da ZuckPay: **Integrações → API** → copie o **Client ID** e o **Client Secret**.
2. Cole no `.env`:
   ```
   ZUCKPAY_CLIENT_ID=...
   ZUCKPAY_CLIENT_SECRET=...
   ```
3. Ainda em **Credenciais API**, gere o **Webhook Secret** e cole no `.env`:
   ```
   ZUCKPAY_WEBHOOK_SECRET=...
   ```
   > É uma chave **diferente** do Client Secret. Sem ela a ZuckPay envia o
   > postback sem assinatura e o servidor aceita sem conseguir validar —
   > funciona, mas qualquer um que descubra a URL poderia marcar um pedido
   > como pago. **Gere o secret antes de vender de verdade.**
4. Os endpoints já vêm preenchidos no `.env.example` e não precisam de ajuste:
   ```
   ZUCKPAY_BASE_URL=https://www.zuckpay.com.br/conta
   ZUCKPAY_PIX_PATH=/v3/pix/qrcode
   ZUCKPAY_STATUS_PATH=/v3/pix/status
   ZUCKPAY_CARD_PATH=/v3/card/charge
   ```
   > Autenticação **Basic** `base64(client_id:client_secret)`; o valor vai em
   > **reais** (`68.90` = R$ 68,90), não em centavos. A URL precisa do `www` —
   > sem ele o CDN vira o POST em GET e devolve 405.
5. Quando o site estiver publicado, preencha `PUBLIC_URL=https://seudominio.com.br`.
   O `urlnoty` é enviado em cada cobrança, apontando para:
   `https://seudominio.com.br/api/webhook/zuckpay`

   Com o Webhook Secret configurado, o postback só é aceito com
   `X-ZuckPay-Signature` válido (`t=<ts>,v1=<hex>`, HMAC-SHA256 de
   `"<ts>.<corpo_cru>"`), com janela anti-replay de 5 minutos.

## 4. Selos do rodapé (Site Blindado / SSL)

No rodapé das duas páginas existem dois espaços marcados:

```html
<div class="selo-slot" data-slot="site-blindado">Selo Site Blindado</div>
<div class="selo-slot" data-slot="ssl">Selo SSL</div>
```

Cada empresa te entrega um **script oficial** no painel dela. Troque a `<div>` inteira
pelo código que eles fornecem. Não vale copiar a imagem do selo de outro site: o selo
real é clicável e leva ao certificado no nome da sua empresa — é isso que o cliente checa.

## 5. Cartão de crédito

O checkout já tem o formulário de cartão completo (validação de Luhn, detecção de
bandeira, validade, CVV e parcelamento em até 10x). O envio pro gateway está em
`zuckpay.js` → função `cobrarCartao()` (fluxo nacional `card_raw`, até 12x). O checkout do site vende só por Pix hoje — a função existe caso o cartão seja reativado.

Em modo simulado, para testar: qualquer cartão válido aprova
(ex: `4111 1111 1111 1111`); cartão terminado em `0000` é recusado.

**Importante:** o servidor nunca grava o número do cartão — só os 4 últimos dígitos.
Se um dia guardar o número completo, você entra nas regras de PCI-DSS.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `server.js` | Servidor, criação de pedidos, consulta de status, webhook |
| `zuckpay.js` | **Toda** a comunicação com a ZuckPay (único arquivo a ajustar) |
| `public/index.html` | Página de vendas do produto |
| `public/checkout.html` | Checkout em 3 etapas (dados → pagamento → PIX) |
| `pedidos.json` | Pedidos salvos (criado sozinho; não sobe pro Git) |

## Como o pagamento funciona

1. Cliente preenche os dados → `POST /api/pedidos`
2. Servidor chama a ZuckPay e devolve o PIX copia e cola + QR Code
3. Checkout pergunta `GET /api/pedidos/:id/status` a cada 5 segundos
4. A ZuckPay também avisa por `POST /api/webhook/zuckpay` quando o PIX cai
5. Tela de "Pagamento confirmado" aparece sozinha

## Antes de vender de verdade

- Trocar o CNPJ no rodapé do checkout pelo real
- Escrever as páginas de Política de Privacidade, Trocas e Termos de Uso (os links do rodapé estão vazios)
- Publicar com HTTPS (o selo "conexão segura" precisa ser verdade)
- Os depoimentos e o "12.000 pessoas" são texto de exemplo — troque por dados reais para não ter problema com o Procon/CDC
