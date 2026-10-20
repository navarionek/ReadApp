import { confettiBurst, confettiFountain, confettiRain } from './confetti.js';
import { goTo } from './shell.js';
import { state } from './state.js';
import { el, icon, refreshIcons } from './ui.js';

/* ----------------- Podsumowanie po dodaniu książki: co zmieniło się w rankingu ----------------- */
const firstName = name => (name || '?').split(' ')[0];

// Zdjęcie rankingu sprzed zapisu (wołane tuż przed dodaniem wpisu)
export function snapshotRanking() {
  return state.lastRanked.map(r => ({ ...r }));
}

function countUp(node, from, to, delay, duration, prefix = '') {
  node.textContent = `${prefix}${from}`;
  const startAt = performance.now() + delay;
  const step = now => {
    const t = Math.min(1, Math.max(0, (now - startAt) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = `${prefix}${Math.round(from + (to - from) * eased)}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Porównuje ranking przed i po (obie listy posortowane od najlepszego)
export function compareRankings(before, after, myId) {
  const posIn = (list, id) => list.findIndex(r => r.key === myId) + 1;
  const wasIn = before.some(r => r.key === myId);
  const rankBefore = wasIn ? posIn(before, myId) : before.length + 1;
  const rankAfter = posIn(after, myId) || after.length;
  const pointsBefore = before.find(r => r.key === myId)?.points ?? 0;
  const pointsAfter = after.find(r => r.key === myId)?.points ?? 0;

  const aheadAfter = new Set(after.slice(0, rankAfter - 1).map(r => r.key));
  const overtaken = wasIn
    ? before.slice(0, rankBefore - 1).filter(r => !aheadAfter.has(r.key)).map(r => r.name)
    : after.slice(rankAfter).map(r => r.name);  // nowa osoba „wyprzedza” wszystkich pod sobą
  const next = rankAfter > 1 ? after[rankAfter - 2] : null;       // osoba tuż nad nami
  const second = rankAfter === 1 ? after[1] ?? null : null;       // pierwsze miejsce: kto depcze po piętach

  return { wasIn, rankBefore, rankAfter, pointsBefore, pointsAfter, overtaken, next, second };
}

export function showAddSummary(before, { title, pts }) {
  if (!state.currentUser) return;
  const c = compareRankings(before, state.lastRanked, state.currentUser.id);
  const promoted = c.rankAfter < c.rankBefore;
  const first = c.rankAfter === 1;
  const keptFirst = first && c.wasIn && c.rankBefore === 1;

  let headline;
  let iconName;
  let tone;
  if (first && !keptFirst) {
    headline = 'Jesteś na 1. miejscu!';
    iconName = 'crown';
    tone = 'gold';
  } else if (keptFirst) {
    headline = 'Prowadzisz jak szalony';
    iconName = 'crown';
    tone = 'gold';
  } else if (promoted) {
    headline = c.wasIn ? 'Awans w rankingu!' : 'Witaj w rankingu!';
    iconName = 'trending-up';
    tone = 'up';
  } else {
    headline = 'Dodane!';
    iconName = 'circle-check';
    tone = 'neutral';
  }

  const details = [];
  if (c.overtaken.length) {
    details.push(['swords', `Wyprzedzasz: ${c.overtaken.map(firstName).join(', ')}`]);
  }
  if (first && c.second) {
    details.push(['shield-check', `Przewaga nad ${firstName(c.second.name)}: ${c.pointsAfter - c.second.points} pkt`]);
  } else if (c.next) {
    details.push(['target', `Do ${firstName(c.next.name)} (#${c.rankAfter - 1}) brakuje ${c.next.points - c.pointsAfter + 1} pkt`]);
  }

  const rankBlock = el('div', { class: 'summary-rank' }, [
    ...(c.rankBefore !== c.rankAfter && c.wasIn
      ? [el('span', { class: 'summary-rank-old', text: `#${c.rankBefore}` }), el('span', { class: 'summary-rank-arrow' }, [icon('arrow-right')])]
      : []),
    el('span', { class: 'summary-rank-new', text: `#${c.rankAfter}` }),
  ]);

  const gained = el('span', { class: 'summary-chip-value', text: '+0' });
  const total = el('span', { class: 'summary-chip-value', text: String(c.pointsBefore) });

  const closeBtn = el('button', { type: 'button', class: 'btn btn-outline', text: 'Zamknij' });
  const rankingBtn = el('button', { type: 'button', class: 'btn btn-primary' }, [icon('trophy'), el('span', { text: 'Zobacz ranking' })]);

  const card = el('div', { class: `summary-card summary-${tone}` }, [
    el('div', { class: 'summary-icon' }, [icon(iconName)]),
    el('h2', { id: 'summary-title', class: 'summary-title', text: headline }),
    el('p', { class: 'summary-book', text: title }),
    el('div', { class: 'summary-chips' }, [
      el('div', { class: 'summary-chip' }, [gained, el('span', { class: 'summary-chip-label', text: 'punktów za książkę' })]),
      el('div', { class: 'summary-chip' }, [total, el('span', { class: 'summary-chip-label', text: 'razem w tym roku' })]),
      el('div', { class: 'summary-chip' }, [rankBlock, el('span', { class: 'summary-chip-label', text: 'miejsce' })]),
    ]),
    ...(details.length
      ? [el('ul', { class: 'summary-details' }, details.map(([ic, text], i) => {
          const li = el('li', {}, [icon(ic), el('span', { text })]);
          li.style.setProperty('--i', String(i));
          return li;
        }))]
      : []),
    el('div', { class: 'summary-actions' }, [closeBtn, rankingBtn]),
  ]);

  const overlay = el('div', { class: 'modal summary-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'summary-title' }, [card]);
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  closeBtn.addEventListener('click', close);
  rankingBtn.addEventListener('click', () => {
    close();
    goTo('ranking');
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  refreshIcons();

  countUp(gained, 0, pts, 350, 800, '+');
  countUp(total, c.pointsBefore, c.pointsAfter, 700, 900);

  // Konfetti: 1. miejsce = wodotrysk, awans = salwa, zwykłe dodanie = nic
  setTimeout(() => {
    if (!overlay.isConnected) return;
    const r = card.getBoundingClientRect();
    const x = r.left + r.width / 2;
    if (first && !keptFirst) {
      confettiBurst(x, r.top + 40, { count: 130, speed: 950, spread: Math.PI });
      confettiFountain(x, r.top + 20, { duration: 2400, rate: 180, speed: 1150 });
      confettiRain(2600);
    } else if (keptFirst) {
      confettiFountain(x, r.top + 20, { duration: 1500, rate: 140, speed: 1000 });
    } else if (promoted) {
      confettiBurst(x, r.top + 40, { count: 110, speed: 850, spread: Math.PI });
      confettiBurst(r.left + 30, r.top + 120, { count: 40, speed: 700, spread: 0.7, angle: -Math.PI / 4 });
      confettiBurst(r.right - 30, r.top + 120, { count: 40, speed: 700, spread: 0.7, angle: (-3 * Math.PI) / 4 });
    }
  }, 500);
}
