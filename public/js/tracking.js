/* ============================================================================
   RASTREAMENTO — Meta Pixel + Utmify
   ----------------------------------------------------------------------------
   >>> COLE SEUS IDS AQUI. Deixando vazio, o rastreamento fica desligado. <<<

   META_PIXEL_ID   -> Gerenciador de Eventos do Meta > Fontes de dados > seu
                      pixel. É um número de 15 ou 16 dígitos.
   UTMIFY_PIXEL_ID -> Painel da Utmify > Pixel > criar/copiar ID.
   ========================================================================== */
const META_PIXEL_ID = '1780777813273982';
const UTMIFY_PIXEL_ID = '';

const PRODUTO_TRACK = {
  id: 'kit-halteres-6em1',
  nome: 'Kit Halteres Ajustavel 6 em 1',
  valor: 68.90,
  moeda: 'BRL',
};

/* ---------- Meta Pixel ---------- */
(function () {
  if (!META_PIXEL_ID) return;
  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */
  fbq('init', META_PIXEL_ID);
  fbq('track', 'PageView');
})();

/* ---------- Utmify: captura de UTM + pixel ---------- */
(function () {
  // Guarda os parâmetros da campanha para não se perderem entre as páginas
  const utms = new URLSearchParams(location.search);
  const chaves = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  const achados = {};
  chaves.forEach((k) => { if (utms.get(k)) achados[k] = utms.get(k); });
  if (Object.keys(achados).length) {
    try { sessionStorage.setItem('utms', JSON.stringify(achados)); } catch {}
  }

  if (!UTMIFY_PIXEL_ID) return;

  const s1 = document.createElement('script');
  s1.src = 'https://cdn.utmify.com.br/scripts/utms/latest.js';
  s1.async = true; s1.defer = true;
  s1.setAttribute('data-utmify-prevent-xcod-sck', '');
  s1.setAttribute('data-utmify-prevent-subids', '');
  document.head.appendChild(s1);

  window.pixelId = UTMIFY_PIXEL_ID;
  const s2 = document.createElement('script');
  s2.src = 'https://cdn.utmify.com.br/scripts/pixel/pixel.js';
  s2.async = true; s2.defer = true;
  document.head.appendChild(s2);
})();

/* ---------- Eventos ---------- */
const track = (evento, dados) => {
  if (typeof fbq === 'function') fbq('track', evento, dados);
};

// Chame nas páginas conforme o momento da jornada
window.rastrear = {
  verProduto() {
    track('ViewContent', {
      content_ids: [PRODUTO_TRACK.id],
      content_name: PRODUTO_TRACK.nome,
      content_type: 'product',
      value: PRODUTO_TRACK.valor,
      currency: PRODUTO_TRACK.moeda,
    });
  },
  iniciarCheckout() {
    track('InitiateCheckout', {
      content_ids: [PRODUTO_TRACK.id],
      num_items: 1,
      value: PRODUTO_TRACK.valor,
      currency: PRODUTO_TRACK.moeda,
    });
  },
  escolherPagamento(metodo) {
    track('AddPaymentInfo', {
      content_ids: [PRODUTO_TRACK.id],
      value: PRODUTO_TRACK.valor,
      currency: PRODUTO_TRACK.moeda,
      payment_method: metodo,
    });
  },
  comprar(pedidoId) {
    // eventID evita contar duas vezes se um dia ligarmos a API de Conversões
    if (typeof fbq === 'function') {
      fbq('track', 'Purchase', {
        content_ids: [PRODUTO_TRACK.id],
        content_name: PRODUTO_TRACK.nome,
        value: PRODUTO_TRACK.valor,
        currency: PRODUTO_TRACK.moeda,
      }, { eventID: pedidoId });
    }
  },
};
