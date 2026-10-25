import { story } from './story.js';

const container = document.querySelector('#story');
const controls = document.querySelector('#controls');
const button = document.querySelector('#play');
const progress = document.querySelector('#progress');
const status = document.querySelector('#status');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const totalMs = story.scenes.reduce((total, scene) => total + scene.durationMs, 0);
let elapsedMs = 0;
let startedAt = 0;
let timer = null;
let state = 'ready';

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

document.title = story.title;
document.documentElement.style.setProperty('--connection-duration', `${story.connectionDurationMs}ms`);
document.querySelector('#eyebrow').textContent = story.eyebrow;
document.querySelector('#review-note').textContent = story.reviewNote;
progress.max = totalMs;
progress.setAttribute('aria-label', story.controls.progress);
const sections = story.scenes.map((scene, index) => {
  const section = document.createElement('section');
  section.className = 'scene';
  const heading = element('h1', scene.heading);
  heading.id = `scene-${index}`;
  section.setAttribute('aria-labelledby', heading.id);
  const visual = document.createElement('div');
  visual.className = 'visual';
  visual.setAttribute('aria-hidden', 'true');
  for (const label of scene.labels) visual.append(element('span', label));
  const sources = document.createElement('p');
  sources.className = 'sources';
  for (const source of scene.sources) {
    const link = element('a', source.label);
    link.href = source.url;
    sources.append(link);
  }
  section.append(heading, element('p', scene.body, 'body'), visual, sources);
  container.append(section);
  return section;
});

function render() {
  let endMs = 0;
  let current = story.scenes.length - 1;
  for (let index = 0; index < story.scenes.length; index++) {
    endMs += story.scenes[index].durationMs;
    if (elapsedMs < endMs) { current = index; break; }
  }
  sections.forEach((section, index) => { section.hidden = !motion.matches && index !== current; });
  controls.hidden = motion.matches;
  document.body.dataset.playing = String(state === 'playing' && !motion.matches);
  button.textContent = story.controls[state === 'playing' ? 'pause' : state === 'complete' ? 'replay' : 'play'];
  status.textContent = story.status[motion.matches ? 'reduced' : state];
  progress.value = elapsedMs;
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function tick() {
  elapsedMs = Math.min(totalMs, performance.now() - startedAt);
  if (elapsedMs === totalMs) { state = 'complete'; stop(); }
  render();
}

button.addEventListener('click', () => {
  if (state === 'playing') {
    tick();
    stop();
    if (state !== 'complete') state = 'paused';
  } else {
    if (state === 'complete') elapsedMs = 0;
    state = 'playing';
    startedAt = performance.now() - elapsedMs;
    timer = setInterval(tick, 100);
  }
  render();
});
motion.addEventListener('change', () => {
  if (state === 'playing') {
    tick();
    stop();
    if (state !== 'complete') state = 'paused';
  }
  render();
});
render();
