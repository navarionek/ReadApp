import { einkEnabled } from './eink.js';

/* ----------------- Logo: mrugnięcie jak żarówka po włączeniu apki ----------------- */
// Chwilę po starcie (i po intro ze ścianą okładek, jeśli jest) napis „Czytanko” mruga jak zapalana żarówka
// i rozbłyskuje poświatą. Raz na uruchomienie; bez tego na czytniku i przy ograniczonym ruchu.
export function flickerLogoSoon() {
  const title = document.querySelector('.app-title');
  if (!title || einkEnabled() || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const busy = () => document.documentElement.classList.contains('intro-pending')
    || document.body.classList.contains('wall-intro')
    || document.body.classList.contains('wall-intro-reveal');
  let tries = 0;
  const wait = () => {
    if (busy() && tries++ < 40) {
      setTimeout(wait, 250);
      return;
    }
    setTimeout(() => {
      title.classList.add('flicker');
      title.addEventListener('animationend', () => title.classList.remove('flicker'), { once: true });
    }, 900);
  };
  wait();
}
