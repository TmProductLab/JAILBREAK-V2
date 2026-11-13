
(function (root) {
  "use strict";

  const SIZE = 7;
  const CENTER = [3,3];
  const EXIT = { D0: [0, -1, "North"], D6: [0, 1, "South"], A3: [-1, 0, "West"], G3: [1, 0, "East"] };
  const TUNNELS = { B2: ["F4", "Alpha"], F4: ["B2", "Alpha"], F2: ["B4", "Beta"], B4: ["F2", "Beta"] };
  // Each run spans a range of tile edges: [orientation, fixed gridline, start, end].
  const WALLS = [
    ["v",2,0,2],["v",2,3,5],["v",5,1,4],["v",5,5,7],
    ["v",1,4,6],["v",6,0,2],["v",4,0,1],["v",4,5,7],["v",3,1,2],["v",3,5,6],
    ["h",2,0,1],["h",2,2,4],["h",2,5,6],["h",5,1,3],
    ["h",3,0,2],["h",3,5,6],["h",4,5,6]
  ];
  const DIR = [[0,-1],[1,0],[0,1],[-1,0]];
  const other = team => team === "escape" ? "security" : "escape";
  const coordinate = ([x,y]) => x >= 0 && x < SIZE && y >= 0 && y < SIZE ? "ABCDEFG"[x] + y : null;
  const xy = cell => cell === "jail" ? CENTER : ["ABCDEFG".indexOf(cell[0]), Number(cell[1])];
  const jailCell = coordinate(CENTER);
  const jailDoors = DIR.map(([dx,dy]) => coordinate([CENTER[0]+dx,CENTER[1]+dy]));
  const wallEdges = new Set();
  for (const [orientation,line,start,end] of WALLS) {
    for (let i=start; i<end; i++) wallEdges.add(orientation+":"+line+":"+i);
  }

  function connected(from,to) {
    if (!from || !to || from === jailCell || to === jailCell) return false;
    const [x,y] = xy(from), [nx,ny] = xy(to);
    if (Math.abs(x-nx)+Math.abs(y-ny) !== 1) return false;
    const edge = x === nx ? "h:"+Math.max(y,ny)+":"+x : "v:"+Math.max(x,nx)+":"+y;
    return !wallEdges.has(edge);
  }

  const distances = new Map();
  for (let y=0; y<SIZE; y++) {
    for (let x=0; x<SIZE; x++) {
      const origin = coordinate([x,y]);
      if (origin === jailCell) continue;
      const found = new Map([[origin,0]]);
      const queue = [origin];
      for (let i=0; i<queue.length; i++) {
        const from = queue[i];
        const [fx,fy] = xy(from);
        for (const [dx,dy] of DIR) {
          const to = coordinate([fx+dx,fy+dy]);
          if (connected(from,to) && !found.has(to)) {
            found.set(to,found.get(from)+1);
            queue.push(to);
          }
        }
      }
      distances.set(origin,found);
    }
  }
  const distance = (a,b) => distances.get(a)?.get(b) ?? SIZE*SIZE;
  const occupant = (state, cell) => state.pieces.find(piece => piece.at === cell);
  const marked = (state, piece, at) => state.lock?.id === piece.id && state.lock.at === at;

  function start() {
    return {
      pieces: [
        { id: "P", team: "escape", type: "prisoner", at: "jail" },
        ...["A4","B1","B5","F1","F5","G2"].map((at,i) => ({ id: "A"+(i+1), team: "escape", type: "associate", at })),
        ...["C1","E1","B3","F3","C5","E5"].map((at,i) => ({ id: "G"+(i+1), team: "security", type: "guard", at }))
      ],
      turn: "escape", turns: 0, passes: 0, lock: null, result: null
    };
  }

  function moves(state, id) {
    if (state.result) return [];
    const piece = state.pieces.find(p => p.id === id && p.team === state.turn);
    if (!piece) return [];
    const action = (kind, to, target, beyond) => ({ id, kind, from: piece.at, to, target, beyond });
    if (piece.at === "jail") return jailDoors.filter(at => !occupant(state,at)).map(at => action("leave",at));

    const [x,y] = xy(piece.at);
    const actions = [];
    for (const [dx,dy] of DIR) {
      const to = coordinate([x+dx,y+dy]);
      if (!to) {
        const exit = EXIT[piece.at];
        if (piece.type === "prisoner" && exit && exit[0] === dx && exit[1] === dy) {
          actions.push(action("escape", "out-"+piece.at));
        }
        continue;
      }
      if (!connected(piece.at,to) || marked(state, piece, to)) continue;
      const target = occupant(state, to);
      const beyond = coordinate([x+2*dx,y+2*dy]);
      if (!target) {
        actions.push(action("move", to));
        if (piece.type === "prisoner" && connected(to,beyond) && !occupant(state,beyond) && !marked(state,piece,beyond)) {
          actions.push(action("sprint", beyond));
        }
        continue;
      }
      const exit = EXIT[to];
      const outward = !beyond && exit && exit[0] === dx && exit[1] === dy;
      if (piece.type === "guard" && target.type === "prisoner") {
        actions.push(action("capture", to, target.id));
      } else if (outward && piece.type === "associate" && target.type === "prisoner") {
        actions.push(action("assist", to, target.id));
      } else if (outward && piece.type === "prisoner" && target.type === "associate") {
        actions.push(action("eject", to, target.id));
      } else if (piece.team !== target.team && piece.type !== "prisoner" && target.type !== "prisoner") {
        if (outward) actions.push(action("eject", to, target.id));
        else if (connected(to,beyond) && !occupant(state,beyond)) actions.push(action("push", to, target.id, beyond));
      }
      // At an aligned exit, pushing the Associate out and sacrificing it have the same outcome.
      else if (piece.type === "prisoner" && target.type === "associate") {
        actions.push(action("sacrifice", to, target.id));
      }
    }
    const tunnel = piece.type === "prisoner" && TUNNELS[piece.at];
    if (tunnel && !occupant(state, tunnel[0])) actions.push(action("tunnel", tunnel[0]));
    return actions;
  }

  function actions(state) {
    if (state.result) return [];
    const all = state.pieces.filter(p => p.team === state.turn).flatMap(p => moves(state, p.id));
    return all.length ? all : [{ kind: "pass" }];
  }

  function apply(state, action) {
    let pieces = state.pieces;
    let result = null;
    let lock = null;
    if (action.kind !== "pass") {
      const remove = ["capture","sacrifice","eject","assist"].includes(action.kind) ? action.target
        : action.kind === "escape" ? action.id : null;
      pieces = pieces.filter(p => p.id !== remove).map(p => {
        if (p.id === action.id) return { ...p, at: action.to };
        if (p.id === action.target && action.kind === "push") return { ...p, at: action.beyond };
        return p;
      });
      if (action.kind === "push") lock = { id: action.target, at: action.to };
      if (action.kind === "capture") result = { winner: "security", reason: "A Guard captured the Prisoner." };
      if (action.kind === "escape" || action.kind === "assist") {
        const exit = EXIT[action.kind === "assist" ? action.to : action.from];
        result = { winner: "escape", reason: "The Prisoner escaped through the "+exit[2].toLowerCase()+" gate." };
      }
    }
    const turns = state.turns+1;
    const passes = action.kind === "pass" ? state.passes+1 : 0;
    if (!result && passes >= 2) result = { winner: "draw", reason: "Neither team had a legal move." };
    if (!result && turns >= 60) result = { winner: "draw", reason: "The match reached the 60-turn limit." };
    return { pieces, result, lock, turns, passes, turn: other(state.turn) };
  }

  function evaluate(state) {
    const p = state.pieces.find(piece => piece.type === "prisoner");
    const guards = state.pieces.filter(piece => piece.type === "guard");
    const associates = state.pieces.filter(piece => piece.type === "associate");
    const posture = associates.length * 2 - guards.length * 2.5;
    if (p.at === "jail") {
      const nearest = Math.min(12, ...guards.flatMap(g => jailDoors.map(door => distance(g.at,door))));
      return posture - 9 + nearest * 0.7;
    }
    const nearest = Math.min(12, ...guards.map(g => distance(g.at,p.at)));
    const plans = Object.keys(EXIT).map(gate => {
      const guardDistance = Math.min(12, ...guards.map(g => distance(g.at,gate)));
      return distance(p.at,gate) + Math.max(0,3-guardDistance)*1.1;
    });
    const support = associates.filter(a => distance(a.at,p.at) <= 2).length;
    return posture + 12 - Math.min(...plans)*2.5 + Math.min(nearest,5)*2 + support*0.65;
  }

  function search(state, depth, alpha, beta) {
    if (state.result) return state.result.winner === "draw" ? 0 : (state.result.winner === "escape" ? 1 : -1) * (10000+depth);
    if (!depth) return evaluate(state);
    const max = state.turn === "escape";
    let best = max ? -Infinity : Infinity;
    for (const action of actions(state)) {
      const score = search(apply(state,action),depth-1,alpha,beta);
      best = max ? Math.max(score,best) : Math.min(score,best);
      if (max) alpha = Math.max(alpha,best);
      else beta = Math.min(beta,best);
      if (alpha >= beta) break;
    }
    return best;
  }

  function computer(state) {
    const available = actions(state);
    let pick = null;
    let best = -Infinity;
    const sign = state.turn === "escape" ? 1 : -1;
    for (const action of available) {
      const score = sign * search(apply(state,action),2,-Infinity,Infinity);
      if (score > best || score === best && Math.random() < 0.28) {
        best = score;
        pick = action;
      }
    }
    return pick;
  }

  const api = { SIZE, CENTER, EXIT, TUNNELS, WALLS, other, coordinate, xy, connected, occupant, start, moves, actions, apply, computer };
  if (typeof module !== "undefined") module.exports = api;
  else root.Jailbreak = api;
})(globalThis);

