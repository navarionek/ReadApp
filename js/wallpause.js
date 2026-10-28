/* ----------------- Ściana okładek poza Startem ----------------- */
// Przy wyjściu ze Startu ściana okładek płynnie gaśnie (style.css, .cover-bg), a gdy już jej nie widać,
// przestaje się ruszać (nie zużywa baterii). Po powrocie na Start rusza dokładnie z tego samego miejsca.
let asleep = null;

function wallAnimations() {
  return [...document.querySelectorAll('#cover-bg .tv-wall-strip')].flatMap(strip => strip.getAnimations());
}

export function onScreenShown(name) {
  if (name === 'start') {
    clearTimeout(asleep?.timer);
    asleep?.anims.forEach(anim => anim.play());
    asleep = null;
    return;
  }
  if (asleep) return;
  asleep = {
    anims: [],
    timer: setTimeout(() => {
      if (!asleep) return;
      asleep.anims = wallAnimations().filter(anim => anim.playState === 'running');
      asleep.anims.forEach(anim => anim.pause());
    }, 800),
  };
}
