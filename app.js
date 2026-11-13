
"use strict";

const game = globalThis.Jailbreak;
const byId = id => document.getElementById(id);
const board = byId("board");
const cells = new Map();
const setup = byId("setup-dialog");
const rules = byId("rules-dialog");
const preferencesDialog = byId("settings-dialog");
const preferencesForm = byId("settings-form");
const confirmDialog = byId("confirm-dialog");
const teamNames = { escape: "Escape", security: "Security" };
const verbs = {
  move: "Move", sprint: "Move 2 spaces", leave: "Leave Jail", capture: "Capture", tunnel: "Use tunnel",
  sacrifice: "Sacrifice", push: "Push", escape: "Escape", assist: "Push Prisoner out", eject: "Push off board"
};
const compassNames = ["north","east","south","west"];
const sprites = {
  prisoner: "./assets/prisoner.webp",
  associate: "./assets/associate.webp",
  guard: "./assets/guard.webp"
};
const boardEdge = 8;
const spacing = (100-2*boardEdge)/game.SIZE;
const centerOf = index => boardEdge+(index+0.5)*spacing;

let state = game.start();
let settings = { mode: "local", side: "escape" };
let selected = null;
let pending = null;
let recent = [];
let timer = 0;
let matchStarted = false;
let audioContext;
let effectNoise;
let moving = false;

const preferenceKey = "jailbreak.preferences.v1";
const defaults = { sound:true, volume:45, hints:true, history:true, contrast:false };
const footstep = at => ({at, noise:190, length:.065, level:.55});
const scrape = at => ({at, noise:540, length:.17, level:.45});
const hit = at => ({at, noise:145, length:.105, level:1});
const latch = at => ({at, noise:1450, length:.08, level:.44});
const note = (at,pitch,length=.14,endPitch=pitch) => ({at,pitch,endPitch,length,level:.55});
const audioCues = {
  start: [note(0,220),note(.09,330),note(.18,440)],
  move: [footstep(.05),footstep(.17)],
  sprint: [footstep(.025),footstep(.10),footstep(.17),footstep(.24)],
  leave: [latch(0),footstep(.16),footstep(.26)],
  push: [footstep(.06),hit(.15),scrape(.22)],
  eject: [footstep(.06),hit(.17),scrape(.23),latch(.35)],
  assist: [footstep(.06),hit(.17),latch(.23),footstep(.39)],
  sacrifice: [footstep(.06),hit(.17),note(.26,260,.19,130)],
  capture: [footstep(.06),hit(.17),latch(.23),latch(.31)],
  tunnel: [note(0,230,.21,110),scrape(.09),note(.34,160,.2,520)],
  escape: [latch(.02),scrape(.08),footstep(.19),footstep(.31),footstep(.42)],
  pass: [note(0,220,.12,155)],
  finish: [note(0,310),note(.09,390),note(.18,520)],
  draw: [note(0,300),note(.12,240)]
};
let preferences = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey));
  for (const key of Object.keys(defaults)) {
    if (typeof saved?.[key] === "boolean" && typeof defaults[key] === "boolean") preferences[key] = saved[key];
  }
  if (Number.isFinite(saved?.volume) && saved.volume >= 0 && saved.volume <= 100) preferences.volume = saved.volume;
} catch {
  // Play is available even when the browser blocks local storage.
}

function playSound(cue) {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio || !preferences.sound || !preferences.volume) return;
  try {
    audioContext ??= new Audio();
    const play = () => {
      if (!preferences.sound) return;
      const strength = preferences.volume / 100 * 0.13;
      if (!strength) return;
      const now = audioContext.currentTime;
      for (const effect of audioCues[cue]) {
        const startTime = now+effect.at;
        const endTime = startTime+effect.length;
        const gain = audioContext.createGain();
        let filter;
        let source;
        if (effect.noise) {
          if (!effectNoise) {
            effectNoise = audioContext.createBuffer(1,Math.ceil(audioContext.sampleRate*.2),audioContext.sampleRate);
            const samples = effectNoise.getChannelData(0);
            for (let i=0; i<samples.length; i++) samples[i] = Math.random()*2-1;
          }
          source = audioContext.createBufferSource();
          source.buffer = effectNoise;
          filter = audioContext.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.value = effect.noise;
          filter.Q.value = 1.25;
          source.connect(filter).connect(gain);
        } else {
          source = audioContext.createOscillator();
          source.type = "triangle";
          source.frequency.setValueAtTime(effect.pitch,startTime);
          source.frequency.exponentialRampToValueAtTime(effect.endPitch,endTime);
          source.connect(gain);
        }
        gain.gain.setValueAtTime(0.0001,startTime);
        gain.gain.exponentialRampToValueAtTime(strength*effect.level,startTime+0.011);
        gain.gain.exponentialRampToValueAtTime(0.0001,endTime);
        gain.connect(audioContext.destination);
        source.start(startTime);
        source.stop(endTime);
        source.onended = () => { source.disconnect(); filter?.disconnect(); gain.disconnect(); };
      }
    };
    if (audioContext.state === "running") play();
    else audioContext.resume().then(play).catch(() => {});
  } catch {
    // A missing audio device must never interrupt the match.
  }
}

function applyPreferences() {
  for (const key of ["hints","contrast"]) board.dataset[key] = String(preferences[key]);
  byId("activity-panel").hidden = !preferences.history;
  for (const key of ["sound","hints","history","contrast"]) {
    preferencesForm.elements[key].checked = preferences[key];
  }
  preferencesForm.elements.volume.value = preferences.volume;
  preferencesForm.elements.volume.disabled = !preferences.sound;
  byId("volume-value").textContent = preferences.volume+"%";
  byId("sound-preview").disabled = !preferences.sound || !preferences.volume;
}

function savePreferences() {
  try { localStorage.setItem(preferenceKey,JSON.stringify(preferences)); } catch {}
  applyPreferences();
  render();
}

function showMatch(show) {
  byId("start-page").hidden = show;
  byId("match-page").hidden = !show;
  byId("match-nav").hidden = !show;
  byId("resume-button").hidden = !matchStarted;
  (show ? byId("board-heading") : byId("start-heading")).focus();
  scheduleComputer();
}

function placed(node, x, y) {
  node.style.setProperty("--x", x);
  node.style.setProperty("--y", y);
  board.append(node);
  return node;
}

function decoration(type, x, y) {
  const node = document.createElement("span");
  node.className = type;
  node.setAttribute("aria-hidden", "true");
  return placed(node,x,y);
}

function addCell(at, x, y, type, label) {
  const button = document.createElement("button");
  button.className = type;
  button.dataset.at = at;
  button.dataset.label = label;
  placed(button,x,y);
  cells.set(at,button);
  return button;
}

function prop(name,x,y) {
  const node = decoration("maze-prop "+name,x,y);
  const image = document.createElement("img");
  image.src = "./assets/"+name+".webp";
  image.alt = "";
  image.draggable = false;
  node.append(image);
}

for (const [name,x,y] of [["security",27,27],["utility",73,27],["storage",27,73],["medical",73,73]]) {
  decoration("facility "+name,x,y);
}

for (let y=0; y<game.SIZE; y++) {
  for (let x=0; x<game.SIZE; x++) decoration("floor-tile",centerOf(x),centerOf(y));
}

function drawWall(orientation,line,start,end,outer = false) {
  const fixed = boardEdge+line*spacing;
  const middle = boardEdge+(start+end)*spacing/2;
  const wall = decoration("maze-wall "+orientation+(outer ? " perimeter" : ""),
    orientation === "v" ? fixed : middle, orientation === "v" ? middle : fixed);
  wall.style.setProperty("--length",(end-start)*spacing+"%");
}

for (const [orientation,line,start,end] of game.WALLS) drawWall(orientation,line,start,end);
for (const orientation of ["h","v"]) {
  for (const line of [0,game.SIZE]) {
    drawWall(orientation,line,0,3.1,true);
    drawWall(orientation,line,3.9,game.SIZE,true);
  }
}

for (const [x,y] of [[8,8],[92,8],[8,92],[92,92]]) prop("watchtower",x,y);
for (const [name,x,y] of [
  ["security-console",29,4],["boiler-room",72,4],["supply-crates",29,96],["infirmary",72,96]
]) prop(name,x,y);
for (const [side,x,y] of [["north",50,44],["east",56,50],["south",50,56],["west",44,50]]) {
  decoration("jail-door "+side,x,y);
}
prop("isolation-cell",50,50);
const tunnelLine = decoration("tunnel-line",50,50);
for (let y=0; y<game.SIZE; y++) {
  for (let x=0; x<game.SIZE; x++) {
    const isJail = x === game.CENTER[0] && y === game.CENTER[1];
    const at = isJail ? "jail" : game.coordinate([x,y]);
    addCell(at,centerOf(x),centerOf(y),isJail ? "cell jail-cell" : "cell",isJail ? "Jail" : "Row "+(y+1)+", column "+(x+1));
  }
}
for (const [at,[dx,dy,name]] of Object.entries(game.EXIT)) {
  const [x,y] = game.xy(at);
  const gate = addCell("out-"+at,centerOf(x)+dx*spacing*0.67,centerOf(y)+dy*spacing*0.67,"gate "+name.toLowerCase(),name+" exit gate");
  const bars = document.createElement("span");
  bars.setAttribute("aria-hidden","true");
  bars.append(document.createElement("i"),document.createElement("i"));
  gate.append(bars);
}

function computerTurn() {
  return !state.result && settings.mode === "computer" && state.turn !== settings.side;
}

function describePiece(piece) {
  if (piece.type === "prisoner") return "Prisoner";
  return (piece.type === "guard" ? "Guard " : "Associate ") + piece.id.slice(1);
}

function directionOf(action) {
  if (action.kind === "escape") return game.EXIT[action.from][2].toLowerCase();
  const [x,y] = game.xy(action.from);
  const [nx,ny] = game.xy(action.to);
  return compassNames[nx > x ? 1 : nx < x ? 3 : ny > y ? 2 : 0];
}

function describeMove(action) {
  if (action.kind === "pass") return teamNames[state.turn]+" passed.";
  const piece = state.pieces.find(item => item.id === action.id);
  const name = describePiece(piece);
  const direction = directionOf(action);
  switch (action.kind) {
    case "leave": return "Prisoner left Jail to the "+direction+".";
    case "capture": return name+" captured the Prisoner.";
    case "push": return name+" pushed "+describePiece(game.occupant(state,action.to))+" "+direction+".";
    case "sacrifice": return "Prisoner sacrificed an Associate to the "+direction+".";
    case "eject": return name+" pushed "+describePiece(game.occupant(state,action.to))+" off the board.";
    case "assist": return name+" pushed the Prisoner through the "+game.EXIT[action.to][2].toLowerCase()+" gate.";
    case "escape": return "Prisoner escaped through the "+game.EXIT[action.from][2].toLowerCase()+" gate.";
    case "tunnel": return "Prisoner took a tunnel.";
    case "sprint": return "Prisoner moved two spaces "+direction+".";
    default: return name+" moved "+direction+".";
  }
}

function render() {
  const prisoner = state.pieces.find(piece => piece.type === "prisoner");
  const revealed = !state.result && prisoner && game.TUNNELS[prisoner.at];
  const legal = selected ? game.moves(state, selected) : [];
  const map = new Map(legal.map(action => [action.to,action]));
  const isComputer = computerTurn();
  const canPass = !state.result && game.actions(state)[0].kind === "pass";
  const chosen = state.pieces.find(piece => piece.id === selected);
  tunnelLine.hidden = !revealed;
  if (revealed) {
    const [x1,y1] = game.xy(prisoner.at);
    const [x2,y2] = game.xy(revealed[0]);
    tunnelLine.style.setProperty("--x", (centerOf(x1)+centerOf(x2))/2);
    tunnelLine.style.setProperty("--y", (centerOf(y1)+centerOf(y2))/2);
    tunnelLine.style.setProperty("--angle", Math.atan2(y2-y1,x2-x1)+"rad");
    tunnelLine.style.width = Math.hypot(x2-x1,y2-y1)*spacing+"%";
  }
  for (const [at,button] of cells) {
    const piece = game.occupant(state,at);
    const action = map.get(at);
    const own = Boolean(piece && piece.team === state.turn && !state.result && !isComputer);
    const label = [button.dataset.label];
    if (piece) label.push(describePiece(piece));
    if (action) label.push(verbs[action.kind]);
    if (state.lock?.at === at) label.push("No return for displaced piece");
    if (revealed && (at === prisoner.at || at === revealed[0])) label.push("Tunnel "+revealed[1]);
    button.setAttribute("aria-label", label.join(", "));
    button.tabIndex = own || action ? 0 : -1;
    button.dataset.own = String(own);
    button.dataset.selected = String(Boolean(piece && piece.id === selected));
    button.dataset.revealed = String(Boolean(revealed && (at === prisoner.at || at === revealed[0])));
    button.dataset.lock = String(state.lock?.at === at);
    if (action) button.dataset.action = action.kind;
    else delete button.dataset.action;
    if (!button.classList.contains("cell")) continue;
    button.replaceChildren();
    if (piece) {
      const token = document.createElement("img");
      token.className = "piece "+piece.type;
      token.src = sprites[piece.type];
      token.alt = "";
      token.draggable = false;
      button.append(token);
    }
  }

  const options = byId("move-options");
  options.hidden = legal.length === 0;
  const buttons = legal.map(action => {
    const button = document.createElement("button");
    button.className = "move-option";
    button.dataset.kind = action.kind;
    const destination = action.kind === "tunnel" ? "" : " "+directionOf(action);
    button.textContent = verbs[action.kind]+destination;
    button.addEventListener("click", () => cells.get(action.to).click());
    return button;
  });
  options.replaceChildren(...buttons);

  byId("mode-label").textContent = settings.mode === "local" ? "Local · 2 players" : "Vs computer · "+teamNames[settings.side];
  byId("turn-strip").dataset.team = state.result?.winner ?? state.turn;
  byId("turn-title").textContent = state.result
    ? state.result.winner === "draw" ? "Draw" : teamNames[state.result.winner]+" wins"
    : teamNames[state.turn] + (isComputer ? " · computer" : " to move");
  let note = "Select one of your pieces.";
  if (canPass) note = "No legal actions. Pass the turn.";
  if (revealed && !chosen && !canPass) {
    note = "Tunnel "+revealed[1]+" revealed"+
      (game.occupant(state,revealed[0]) ? " (blocked)" : "");
  }
  if (chosen) {
    const prompt = preferences.hints ? "Choose a highlighted action." : "Choose a destination or use the move list.";
    note = describePiece(chosen)+" selected. "+prompt;
    if (!legal.length) note = chosen.at === "jail"
      ? "All four Jail doors are blocked. Select an Associate."
      : "This piece has no legal actions. Select another piece.";
  }
  byId("turn-note").textContent = state.result?.reason ?? (isComputer ? "Choosing a move…" : note);
  byId("turn-count").textContent = (state.result ? state.turns : state.turns+1) + " / 60";
  byId("escape-count").textContent = state.pieces.filter(p => p.type === "associate").length+" / 6 associates";
  byId("security-count").textContent = state.pieces.filter(p => p.type === "guard").length+" / 6 guards";
  for (const team of ["escape","security"]) {
    byId(team+"-team").dataset.active = String(!state.result && state.turn === team);
  }
  byId("pass-button").hidden = !canPass || isComputer;
  byId("rematch-button").hidden = !state.result;
  byId("action-bar").hidden = byId("pass-button").hidden && byId("rematch-button").hidden;
  byId("empty-log").hidden = Boolean(recent.length);
  const log = recent.map(item => {
    const li = document.createElement("li");
    const number = document.createElement("small");
    number.textContent = String(item.number).padStart(2,"0");
    const text = document.createElement("span");
    text.textContent = item.text;
    li.append(number,text);
    return li;
  });
  byId("move-log").replaceChildren(...log);
}

function scheduleComputer() {
  clearTimeout(timer);
  const paused = () => moving || byId("match-page").hidden || document.querySelector("dialog[open]");
  if (!computerTurn() || paused()) return;
  timer = setTimeout(() => {
    if (computerTurn() && !paused()) commit(game.computer(state));
  },390);
}

const translate = (x,y,scale=1) => "translate("+x+"px,"+y+"px) scale("+scale+")";

function displacement(from,to) {
  const start = from.getBoundingClientRect();
  const end = to.getBoundingClientRect();
  return [(end.left+end.width/2)-(start.left+start.width/2),(end.top+end.height/2)-(start.top+start.height/2)];
}

function openGate(gate,duration,delay) {
  return [...gate.querySelectorAll("i")].map((panel,index) => {
    return panel.animate([
      { transform:"translateX(0)", opacity:1, offset:0 },
      { transform:"translateX("+(index === 0 ? -90 : 90)+"%)", opacity:.25, offset:.32 },
      { transform:"translateX("+(index === 0 ? -90 : 90)+"%)", opacity:.25, offset:1 }
    ], { duration:duration-delay, delay, fill:"forwards" });
  });
}

function animateMovement(action) {
  if (action.kind === "pass" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const from = cells.get(action.from);
  const to = cells.get(action.to);
  const actor = from?.querySelector(".piece");
  if (!actor?.animate || !to) return null;
  const target = to.querySelector(".piece");
  const [dx,dy] = displacement(from,to);
  from.classList.add("piece-in-motion");
  const animations = target ? animateContact(action,actor,target,to,dx,dy) : animateTravel(action,actor,to,dx,dy);
  return Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    for (const animation of animations) animation.cancel();
    from.classList.remove("piece-in-motion");
    to.classList.remove("piece-in-motion","contact-target");
  });
}

function animateTravel(action,actor,to,dx,dy) {
  const durations = { move:225, sprint:320, leave:340, tunnel:530, escape:510 };
  const duration = durations[action.kind];
  const at = (progress,bob=0,scale=1) => translate(dx*progress,dy*progress-bob,scale);
  const bob = Math.min(5,Math.hypot(dx,dy)*.065);
  let frames;
  if (action.kind === "tunnel") {
    frames = [
      { transform:at(0), opacity:1, offset:0 },
      { transform:at(0,-6,.63), opacity:0, offset:.42 },
      { transform:at(1,-6,.63), opacity:0, offset:.57 },
      { transform:at(1,3,1.04), opacity:1, offset:.87 },
      { transform:at(1), opacity:1, offset:1 }
    ];
  } else if (action.kind === "escape") {
    frames = [
      { transform:at(0), opacity:1, offset:0 },
      { transform:at(0), opacity:1, offset:.19 },
      { transform:at(.75,bob), opacity:1, offset:.58 },
      { transform:at(1.15), opacity:.72, offset:.76 },
      { transform:at(1.7,0,.91), opacity:0, offset:1 }
    ];
  } else {
    const stride = action.kind === "sprint" ? [0,.13,.27,.40,.54,.68,.82,1] : [0,.23,.50,.73,1];
    const start = action.kind === "leave" ? .14 : 0;
    frames = stride.map((progress,index) => ({
      offset:start+progress*(1-start),
      transform:at(progress,index%2 ? bob : 0,action.kind === "leave" ? 1+progress*.05 : 1)
    }));
    frames.at(-1).transform = at(1,0,action.kind === "leave" ? 1.05 : 1);
    if (start) frames.unshift({transform:at(0),offset:0});
  }
  const animations = [actor.animate(frames,{ duration, fill:"forwards" })];
  if (action.kind === "escape") animations.push(...openGate(to,duration,0));
  return animations;
}

function animateContact(action,actor,target,to,dx,dy) {
  const duration = action.kind === "push" ? 440 : 510;
  const slidesAway = action.kind === "push" || action.kind === "eject" || action.kind === "assist";
  const exitGate = ["eject","assist"].includes(action.kind) ? cells.get("out-"+action.to) : null;
  let targetFrames;
  if (slidesAway) {
    const [x,y] = displacement(to,exitGate ?? cells.get(action.beyond));
    targetFrames = [
      { transform: translate(0,0), offset: 0 },
      { transform: translate(0,0), offset: .34 },
      { transform: translate(x*.55,y*.55,.94), offset: .52 },
      { transform: translate(x,y), offset: .82 },
      { transform: translate(x*(exitGate ? 1.6 : 1),y*(exitGate ? 1.6 : 1),exitGate ? .8 : 1), opacity: exitGate ? 0 : 1, offset: 1 }
    ];
  } else {
    targetFrames = [
      { transform: translate(0,0), opacity: 1, offset: 0 },
      { transform: translate(0,0), opacity: 1, offset: .32 },
      { transform: translate(dx*.12,dy*.12,.91), opacity: .85, offset: .54 },
      { transform: translate(dx*.2,dy*.2,.7), opacity: 0, offset: 1 }
    ];
  }
  to.classList.add("piece-in-motion","contact-target");
  const animations = [
    actor.animate([
      { transform: translate(0,0), offset: 0 },
      { transform: translate(-dx*.09,-dy*.09,1.04), offset: .15 },
      { transform: translate(dx*.76,dy*.76,1.04), offset: .34 },
      { transform: translate(dx,dy), offset: .79 },
      { transform: translate(dx,dy), offset: 1 }
    ], { duration, fill: "forwards" }),
    target.animate(targetFrames,{ duration, fill: "forwards" })
  ];
  if (exitGate) animations.push(...openGate(exitGate,duration,135));
  return animations;
}

async function commit(action) {
  if (!action || state.result || moving) return;
  const animation = animateMovement(action);
  playSound(action.kind);
  if (animation) {
    moving = true;
    const interactive = [board,byId("match-nav"),byId("move-options")];
    const heldFocus = interactive.some(element => element.contains(document.activeElement));
    for (const element of interactive) element.inert = true;
    board.setAttribute("aria-busy","true");
    try {
      await animation;
    } finally {
      moving = false;
      board.removeAttribute("aria-busy");
      for (const element of interactive) element.inert = false;
      if (heldFocus) byId("board-heading").focus({ preventScroll: true });
    }
  }
  recent.unshift({ number: state.turns+1, text: describeMove(action) });
  state = game.apply(state,action);
  if (state.result) playSound(state.result.winner === "draw" ? "draw" : "finish");
  selected = null;
  pending = null;
  render();
  if (state.result) byId("rematch-button").focus({ preventScroll: true });
  scheduleComputer();
}

function startMatch(nextSettings) {
  clearTimeout(timer);
  settings = nextSettings;
  state = game.start();
  selected = null;
  pending = null;
  recent = [];
  matchStarted = true;
  render();
  showMatch(true);
  playSound("start");
}

board.addEventListener("click", event => {
  const button = event.target.closest("button[data-at]");
  if (!button || computerTurn() || state.result || moving) return;
  const at = button.dataset.at;
  const action = selected && game.moves(state,selected).find(move => move.to === at);
  if (action) {
    if (action.kind === "sacrifice" || action.kind === "eject" && action.id === "P") {
      pending = action;
      byId("confirm-title").textContent = action.kind === "sacrifice" ? "Sacrifice this Associate?" : "Push this Associate out?";
      byId("confirm-text").textContent = "The Associate will be removed for the rest of the match. The Prisoner will take their space.";
      confirmDialog.showModal();
    } else {
      commit(action);
    }
    return;
  }
  const piece = game.occupant(state,at);
  selected = piece && piece.team === state.turn && piece.id !== selected ? piece.id : null;
  render();
  // Put the next Tab stop on this piece's destinations, including destinations earlier on the board.
  if (selected && event.detail === 0) {
    const first = game.moves(state,selected)[0];
    if (first) cells.get(first.to).focus({ preventScroll: true });
  }
});

byId("confirm-move").addEventListener("click", () => {
  const action = pending;
  confirmDialog.close();
  commit(action);
});
confirmDialog.addEventListener("close", () => { pending = null; });
byId("pass-button").addEventListener("click", () => {
  const [action] = game.actions(state);
  if (action?.kind === "pass" && !computerTurn()) commit(action);
});
byId("rematch-button").addEventListener("click", () => startMatch(settings));
byId("menu-button").addEventListener("click", () => showMatch(false));
byId("resume-button").addEventListener("click", () => showMatch(true));
byId("local-button").addEventListener("click", () => startMatch({ mode:"local", side:"escape" }));

function openDialog(dialog) {
  clearTimeout(timer);
  dialog.showModal();
}

for (const id of ["start-help","rules-button"]) byId(id).addEventListener("click", () => openDialog(rules));
for (const id of ["start-settings","settings-button"]) {
  byId(id).addEventListener("click", () => openDialog(preferencesDialog));
}
byId("computer-button").addEventListener("click", () => openDialog(setup));
byId("setup-form").addEventListener("submit", event => {
  event.preventDefault();
  const side = event.target.elements.side.value;
  setup.close();
  startMatch({ mode:"computer", side });
});
preferencesForm.addEventListener("submit", event => event.preventDefault());
preferencesForm.addEventListener("input", event => {
  const { name, checked, valueAsNumber } = event.target;
  if (!Object.hasOwn(defaults,name)) return;
  preferences[name] = name === "volume" ? valueAsNumber : checked;
  savePreferences();
});
byId("reset-settings").addEventListener("click", () => {
  preferences = { ...defaults };
  savePreferences();
});
byId("sound-preview").addEventListener("click", () => playSound("start"));
document.querySelectorAll("[data-close]").forEach(button => {
  button.addEventListener("click", () => byId(button.dataset.close).close());
});
[setup,rules,preferencesDialog].forEach(dialog => dialog.addEventListener("close",scheduleComputer));

applyPreferences();
render();



