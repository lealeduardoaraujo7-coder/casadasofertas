# Casa das Ofertas — Kit Halteres Ajustável 6 em 1

Página de produto + checkout próprio (PIX via AmploPay).

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

## 3. Ligue a AmploPay de verdade

1. No painel da AmploPay: **Credenciais → Criar/Consultar transações** → copie o Client ID e o Client Secret.
2. Cole no `.env`:
   ```
   AMPLOPAY_CLIENT_ID=...
   AMPLOPAY_CLIENT_SECRET=...
   ```
3. **Confira na documentação da AmploPay** a URL base, a rota de criar transação
   e o modo de autenticação, e ajuste no `.env`:
   ```
   AMPLOPAY_BASE_URL=https://api.amplopay.com
   AMPLOPAY_CREATE_PATH=/v1/transactions
   AMPLOPAY_STATUS_PATH=/v1/transactions/{id}
   AMPLOPAY_AUTH_MODE=basic
   ```
   > Esses valores são o padrão mais comum desses gateways, mas **não foram
   > confirmados na doc oficial da AmploPay** (ela não é pública). Se der erro,
   > me mande o print da documentação que eu ajusto o arquivo `amplopay.js`.
4. Quando o site estiver publicado, preencha `PUBLIC_URL=https://seudominio.com.br`
   e cadastre o postback na AmploPay apontando para:
   `https://seudominio.com.br/api/webhook/amplopay`

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
`amplopay.js` → função `cobrarCartao()`.

Em modo simulado, para testar: qualquer cartão válido aprova
(ex: `4111 1111 1111 1111`); cartão terminado em `0000` é recusado.

**Importante:** o servidor nunca grava o número do cartão — só os 4 últimos dígitos.
Se um dia guardar o número completo, você entra nas regras de PCI-DSS.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `server.js` | Servidor, criação de pedidos, consulta de status, webhook |
| `amplopay.js` | **Toda** a comunicação com a AmploPay (único arquivo a ajustar) |
| `public/index.html` | Página de vendas do produto |
| `public/checkout.html` | Checkout em 3 etapas (dados → pagamento → PIX) |
| `pedidos.json` | Pedidos salvos (criado sozinho; não sobe pro Git) |

## Como o pagamento funciona

1. Cliente preenche os dados → `POST /api/pedidos`
2. Servidor chama a AmploPay e devolve o PIX copia e cola + QR Code
3. Checkout pergunta `GET /api/pedidos/:id/status` a cada 5 segundos
4. A AmploPay também avisa por `POST /api/webhook/amplopay` quando o PIX cai
5. Tela de "Pagamento confirmado" aparece sozinha

## Antes de vender de verdade

- Trocar o CNPJ no rodapé do checkout pelo real
- Escrever as páginas de Política de Privacidade, Trocas e Termos de Uso (os links do rodapé estão vazios)
- Publicar com HTTPS (o selo "conexão segura" precisa ser verdade)
- Os depoimentos e o "12.000 pessoas" são texto de exemplo — troque por dados reais para não ter problema com o Procon/CDC
