/* Shared planning and geometry: all buildings, bridge approaches and banks use
   the same world coordinates. No transparent facades or screen-space outlines. */
const CityModel = (() => {
  const BANK = .34;        // default bank margin; each layout may override it
  const WATER = .255;      // half-width of the water surface itself
  const FLOOR = .074;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function random(seed) {
    let n = seed >>> 0;
    return () => ((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 4294967296);
  }
  function segmentDistance(x, z, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
  }
  function riverDistance(x, z, points) {
    let d = Infinity;
    for (let i = 1; i < points.length; i++) d = Math.min(d, segmentDistance(x, z, points[i - 1], points[i]));
    return d;
  }
  function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
  /* Point-to-segment distance for plain coordinates, with the parameter `t` of
     the closest point so callers can interpolate along the segment. */
  function segmentPointDistance(x, z, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    const t = len2 ? clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1) : 0;
    return {d: Math.hypot(x - ax - dx * t, z - az - dz * t), t};
  }
  function segmentDistance2(x, z, road) {
    let best = Infinity;
    for (let i = 1; i < road.path.length; i++) {
      const {d} = segmentPointDistance(x, z, road.path[i-1].x, road.path[i-1].z, road.path[i].x, road.path[i].z);
      if (d < best) best = d;
    }
    return best;
  }
  /* Roads have real width, so plots must clear half the carriageway plus the
     sidewalk before a building may be placed. */
  function roadClearance(x, z, roads, pad = 0) {
    let best = Infinity;
    for (const r of roads) {
      const m = segmentDistance2(x, z, r) - (r.w / 2 + r.sw + .035) - pad;
      if (m < best) best = m;
    }
    return best;
  }
  function openWater(lakes, x, z, r) {
    return lakes.every(lake => !pointInLake(x, z, lake) && riverDistance(x, z, [...lake.points, lake.points[0]]) > r + .24);
  }
  function inLakePolygon(x, z, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  }
  /* Chaikin corner cutting: one pass removes the sharp elbows that a random walk
     leaves behind, so roads read as surveyed routes rather than jitter. */
  function smoothPath(path, passes = 2) {
    let cur = path;
    for (let k = 0; k < passes; k++) {
      if (cur.length < 3) break;
      const next = [cur[0]];
      for (let i = 0; i < cur.length - 1; i++) {
        const a = cur[i], b = cur[i + 1];
        next.push({x: a.x * .75 + b.x * .25, z: a.z * .75 + b.z * .25});
        next.push({x: a.x * .25 + b.x * .75, z: a.z * .25 + b.z * .75});
      }
      next.push(cur[cur.length - 1]);
      cur = next;
    }
    return cur;
  }
  /* Proper segment/segment crossing test, used to find where two roads meet so
     the junction can be turned into a grade separation. */
  function segmentsCross(ax, az, bx, bz, cx, cz, dx, dz) {
    const r1 = bx - ax, r2 = bz - az, s1 = dx - cx, s2 = dz - cz;
    const den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((cx - ax) * s2 - (cz - az) * s1) / den;
    const u = ((cx - ax) * r2 - (cz - az) * r1) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return {x: ax + r1 * t, z: az + r2 * t, angle: Math.atan2(r2, r1), crossAngle: Math.atan2(s2, s1)};
  }
  function roadCrossings(roads) {
    const out = [];
    for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) {
      const A = roads[i], B = roads[j];
      for (let a = 1; a < A.path.length; a++) for (let b = 1; b < B.path.length; b++) {
        const hit = segmentsCross(
          A.path[a-1].x, A.path[a-1].z, A.path[a].x, A.path[a].z,
          B.path[b-1].x, B.path[b-1].z, B.path[b].x, B.path[b].z);
        if (!hit) continue;
        let da = Math.abs(((hit.angle - hit.crossAngle) * 180 / Math.PI) % 180);
        if (da > 90) da = 180 - da;
        out.push({
          x: hit.x, z: hit.z,
          angle: hit.angle,
          otherAngle: hit.crossAngle,
          w: Math.max(A.w, B.w) * 2.6 + .30,
          d: .20,
          lane: A.w,
          type: 3,
          skew: da,
          major: A.rank <= B.rank ? A.rank : B.rank,
        });
      }
    }
    return out;
  }
  /* Where a road meets a body of water it becomes a bridge. The span only has to
     cover the water surface plus the abutments either side, because the road is
     already travelling perpendicular to the crossing. */
  function crossingSpan(p, dir, samples, water) {
    let lo = 0, hi = 0;
    for (const s of [-1, 1]) {
      let reach = water;
      for (let d = water; d <= water + 1.5; d += .04) {
        const q = riverDistance(p.x + dir.x * d * s, p.z + dir.z * d * s, samples);
        if (q <= water + .02) reach = d;
        else if (d > reach + .12) break;
      }
      if (s < 0) lo = reach; else hi = reach;
    }
    return {lo, hi};
  }
  function corners(r, margin = 0) {
    const c = Math.cos(r.angle || 0), s = Math.sin(r.angle || 0);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,b]) => {
      const x = a * (r.w / 2 + margin), z = b * (r.d / 2 + margin);
      return { x: r.x + c * x + s * z, z: r.z - s * x + c * z };
    });
  }
  function overlaps(a, b, margin = 0) {
    const ac = corners(a, margin), bc = corners(b);
    for (const r of [a,b]) {
      const c = Math.cos(r.angle || 0), s = Math.sin(r.angle || 0);
      for (const [x,z] of [[c,-s],[s,c]]) {
        const ap = ac.map(p => p.x*x + p.z*z), bp = bc.map(p => p.x*x + p.z*z);
        if (Math.max(...ap) <= Math.min(...bp) || Math.max(...bp) <= Math.min(...ap)) return false;
      }
    }
    return true;
  }
  function pointInLake(x,z,lake) {
    let inside=false;
    for(let i=0,j=lake.points.length-1;i<lake.points.length;j=i++) {
      const a=lake.points[i],b=lake.points[j];
      if((a.z>z)!==(b.z>z) && x<(b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x) inside=!inside;
    }
    return inside;
  }
  function lakeClear(x,z,radius,lakes) {
    return lakes.every(lake => !pointInLake(x,z,lake) && riverDistance(x,z,[...lake.points,lake.points[0]])>radius+.24);
  }
  /* Several bridges facing the same crossing would give the same bank two arches
     side by side, so each crossing is collapsed to a single representative. */
  function clusterBridges(list, tol = .78) {
    const kept = [];
    for (const b of list) {
      if (kept.some(k => k.type !== b.type && dist2(k.x, k.z, b.x, b.z) < tol * tol)) continue;
      if (kept.some(k => dist2(k.x, k.z, b.x, b.z) < (tol * .45) ** 2)) continue;
      kept.push(b);
    }
    return kept;
  }
  /* The road network is built before anything else is placed, so buildings can be
     kept off the carriageway instead of the roads being drawn over them later.
     Roads are also joined to the network as they are created: a street that stops
     in mid-air is not a street, so each new route is extended until it meets an
     existing one, and anything that still ends up isolated is discarded. */
  function buildRoadNetwork(rand, half, scale, riverSamples, bank, lakeData, facilityData) {
    const roads = [];
    const edge = half - .42;
    const inCity = p => Math.abs(p.x) <= edge && Math.abs(p.z) <= edge;
    const clearOfLakes = (x, z, r) => lakeData.every(l => !inLakePolygon(x, z, l.points) &&
      riverDistance(x, z, [...l.points, l.points[0]]) > r);
    const clearOfFacilities = (x, z, r) => !facilityData.some(b => overlaps({x, z, w: r, d: r}, b, .04));
    const waterFree = (x, z, r) => riverDistance(x, z, riverSamples) > bank + r;

    /* Closest point on any existing road, with the local heading so a joining
       street can be extended across the carriageway it meets. */
    function nearestOnRoads(x, z) {
      let best = null;
      for (const r of roads) for (let i = 1; i < r.path.length; i++) {
        const a = r.path[i-1], b = r.path[i];
        const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
        const t = len2 ? clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1) : 0;
        const px = a.x + dx * t, pz = a.z + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (!best || d < best.d) best = {d, x: px, z: pz, ang: Math.atan2(dz, dx), w: r.w, road: r, idx: i};
      }
      return best;
    }
    /* Extend an open end out to the road it comes near, a little past the
       centreline, so the two carriageways genuinely overlap. */
    function joinEnd(path, end, reach) {
      const p = end === 0 ? path[0] : path[path.length - 1];
      const q = end === 0 ? path[1] : path[path.length - 2];
      const near = nearestOnRoads(p.x, p.z);
      if (!near || near.d > reach) return false;
      const len = Math.hypot(p.x - q.x, p.z - q.z) || 1;
      const ux = (p.x - q.x) / len, uz = (p.z - q.z) / len;
      const over = near.w * .35 + .02;
      const nx = near.x + ux * over, nz = near.z + uz * over;
      if (Math.hypot(nx - p.x, nz - p.z) > .001) {
        if (end === 0) path.unshift({x: nx, z: nz});
        else path.push({x: nx, z: nz});
      }
      return true;
    }
    /* Force a route onto the network. Growing outward from the ends works for an
       open street, but a closed ring has no usable endpoint direction, so the
       nearest point on the ring is spliced to the nearest road instead. That makes
       connectivity a property of construction rather than something to hope for. */
    function connectToNetwork(path) {
      if (!roads.length) return true;
      if (joinEnd(path, 0, 1.5) || joinEnd(path, 1, 1.5)) return true;
      // Closed or stubborn route: splice a lead-in at its closest approach.
      let best = null;
      for (let i = 0; i < path.length; i++) {
        const n = nearestOnRoads(path[i].x, path[i].z);
        if (n && (!best || n.d < best.n.d)) best = {i, n};
      }
      if (!best) return false;
      const target = {x: best.n.x, z: best.n.z};
      const at = path[best.i];
      const insert = (arr, pt) => arr.splice(best.i, 0, pt);
      // Ring: duplicate the join vertex so the loop stays closed and gains a stub.
      if (path.length > 2 && dist2(path[0].x, path[0].z, path[path.length-1].x, path[path.length-1].z) < .01) {
        insert(path, {...target});
        insert(path, {...at});
      } else {
        insert(path, {...target});
      }
      return true;
    }
    function push(pts, w, sw, rank, opts = {}) {
      let path = smoothPath(pts.map(p => ({x: p.x, z: p.z})));
      if (path.length < 2) return false;
      if (roads.length && !opts.allowLoose) {
        if (!connectToNetwork(path)) return false;
      } else if (roads.length) {
        connectToNetwork(path);
      }
      roads.push({path, w, sw, rank});
      return true;
    }
    /* Where a route is anchored to an existing road, extend a stub perpendicular
       to it so the junction is a T rather than a hairline touch. */
    function tJunction(x, z, ang, w, rank) {
      const off = .34;
      const nx = Math.sin(ang), nz = Math.cos(ang);
      const a = {x: x - nx * off, z: z - nz * off};
      const b = {x: x + nx * off, z: z + nz * off};
      if (!inCity(a) || !inCity(b)) return;
      push([a, b], w, .012, rank, {reach: .30});
    }

    /* Spine: a gently meandering arterial. A random walk was tried first but its
       heading accumulates, which drives the road into the city edge and leaves the
       ring roads with nothing to attach to. Oscillating around the centre keeps it
       organic while guaranteeing it stays reachable across the full depth. */
    const spinePath = [];
    const spinePhase = rand() * 6.28;
    const spineAmp = Math.min(half * .22, (edge - half * .1) * .45);
    const spineBend = 1.1 + rand() * .9;
    (function spine() {
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const z = -edge + t * edge * 2;
        const x = clamp(
          Math.sin(t * spineBend + spinePhase) * spineAmp +
          Math.sin(t * 2.6 + spinePhase * 1.7) * spineAmp * .28,
          -edge * .8, edge * .8);
        spinePath.push({x, z});
      }
      push(spinePath, .17, .026, 0, {allowLoose: true, jointStart: false, jointEnd: false});
    })();

    /* Loop: a ring road around a point on the spine, then tied back to the spine
       with two connecting streets so the ring is actually reachable. */
    function loop(centreT, radius, w, sw, rank) {
      const idx = clamp(Math.round(centreT * (spinePath.length - 1)), 0, spinePath.length - 1);
      const c = spinePath[idx];
      const n = 13, pts = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r = radius * (1 + (rand() - .5) * .17);
        pts.push({
          x: clamp(c.x + Math.cos(a) * r * (1 + (rand() - .5) * .06), -edge, edge),
          z: clamp(c.z + Math.sin(a) * r * .86 * (1 + (rand() - .5) * .06), -edge, edge),
        });
      }
      if (!push(pts, w, sw, rank)) return;
      // Two stubs tie the ring to the arterial that spawned it.
      for (const side of [-1, 1]) {
        const ang = Math.atan2(c.z - (c.z + side * radius), c.x - (c.x + side * radius));
        tJunction(c.x, c.z + side * radius * .86, ang, .1, rank + 1);
      }
    }
    loop(.34, half * .52, .12, .018, 2);
    if (scale > 1.25) loop(.72, half * .56, .105, .016, 2);

    /* Perimeter ring road at the edge of the built-up area, joined to the spine
       at four points so it forms a connected circuit rather than a lone box. */
    (function perimeter() {
      const pts = [];
      for (const [sx, sz] of [[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]) {
        pts.push({x: sx * (half - .58), z: sz * (half - .58)});
      }
      push(pts, .1, .015, 3);
    })();

    /* Cross lanes: local streets starting from a point on the network and running
       outward. Each one is pulled onto the network as it is created, so a lane
       either joins properly or is rejected outright. */
    const laneTarget = clamp(Math.round(half * 1.6), 5, 18);
    let lanes = 0;
    for (let i = 0; i < laneTarget * 6 && lanes < laneTarget; i++) {
      const src = roads[Math.floor(rand() * roads.length)];
      if (!src) break;
      const si = 1 + Math.floor(rand() * (src.path.length - 1));
      const anchor = src.path[si];
      const a = rand() * Math.PI * 2;
      const len = half * (.30 + rand() * .55);
      const dx = Math.cos(a), dz = Math.sin(a);
      const curve = (rand() - .5) * .38;
      const pts = [
        {x: anchor.x, z: anchor.z},
        {x: anchor.x + dx * len * .5 + dz * curve, z: anchor.z + dz * len * .5 - dx * curve},
        {x: anchor.x + dx * len, z: anchor.z + dz * len},
      ];
      if (!inCity(pts[2])) continue;
      if (!clearOfLakes(pts[1].x, pts[1].z, .34)) continue;
      if (!clearOfFacilities(pts[1].x, pts[1].z, .42)) continue;
      if (push(pts, .095, .014, 4)) lanes++;
    }

    /* Roads that have nothing to do with the water are kept clear of the far bank
       so they never read as crossing the river, and any that ends up sharing no
       junction with the rest of the network is discarded. */
    const usable = [];
    for (const r of roads) {
      if (r.rank > 2) {
        let dry = true;
        for (const p of r.path) {
          if (!waterFree(p.x, p.z, .1)) { dry = false; break; }
        }
        if (!dry) continue;
      }
      usable.push(r);
    }
    // Connectivity filter: keep only roads reachable from the arterial. This has
    // to measure segment-to-segment, not vertex-to-vertex: a ring road's vertices
    // can sit far from the arterial's while the two still cross.
    const segmentGap = (a, b) => {
      let best = Infinity;
      for (let i = 1; i < a.path.length; i++) for (let j = 1; j < b.path.length; j++) {
        const p = a.path[i-1], q = a.path[i], r = b.path[j-1], s = b.path[j];
        const d = Math.min(
          segmentPointDistance(p.x, p.z, r.x, r.z, s.x, s.z).d,
          segmentPointDistance(q.x, q.z, r.x, r.z, s.x, s.z).d,
          segmentPointDistance(r.x, r.z, p.x, p.z, q.x, q.z).d,
          segmentPointDistance(s.x, s.z, p.x, p.z, q.x, q.z).d);
        if (d < best) best = d;
      }
      return best;
    };
    const adjacency = (a, b) => segmentGap(a, b) < .40;
    const keep = new Set();
    const byRank = [...usable].sort((x, y) => x.rank - y.rank);
    if (byRank.length) {
      keep.add(byRank[0]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const r of byRank) {
          if (keep.has(r)) continue;
          for (const k of keep) {
            if (adjacency(r, k)) { keep.add(r); grew = true; break; }
          }
        }
      }
    }
    return byRank.filter(r => keep.has(r));
  }
  /* Every point where the network meets the river becomes a bridge. The bridge
     records the water span in its local frame so the deck can be drawn exactly
     bank to bank, and the road that owns it knows to continue across. */
  function placeBridges(roads, riverSamples, bank, lakeData, rand) {
    const out = [];
    const water = WATER;
    for (const road of roads) {
      const path = road.path;
      for (let i = 1; i < path.length; i++) {
        const ax = path[i-1].x, az = path[i-1].z, bx = path[i].x, bz = path[i].z;
        const segLen = Math.hypot(bx - ax, bz - az);
        if (segLen < 1e-6) continue;
        const steps = Math.max(2, Math.ceil(segLen / (bank * .3)));
        let runStart = null;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
          const inWater = riverDistance(px, pz, riverSamples) <= water + .02;
          if (inWater && runStart === null) {
            runStart = t;
          } else if (!inWater && runStart !== null) {
            // Crossing closed: keep the midpoint of the stretch that was wet.
            const tMid = (runStart + t) / 2;
            const mid = {x: ax + (bx - ax) * tMid, z: az + (bz - az) * tMid};
            runStart = null;
            const dir = {x: (bx - ax) / segLen, z: (bz - az) / segLen};
            const {lo, hi} = crossingSpan(mid, dir, riverSamples, water);
            // Deck reaches past the promenade on both banks so no gap shows.
            const reach = lo + (bank - water) + .15;
            const span = lo + hi + 2 * (bank - water) + .30;
            // A road that crosses both a lake and the river would put its bridge
            // over open water: the whole deck has to clear every lake, not just
            // its centre.
            if (!lakeClear(mid.x, mid.z, Math.hypot(span, .3) / 2, lakeData)) continue;
            out.push({
              x: mid.x, z: mid.z,
              angle: Math.atan2(dir.z, dir.x),
              w: span,
              d: .22 + rand() * .07,
              lo: reach,
              lane: road.w,
              type: Math.floor(rand() * 3),
              seedOdd: rand() < .5,
            });
          }
        }
      }
    }
    return clusterBridges(out);
  }
  function generate(seed, diameter = 3) {
    diameter = clamp(Math.round(Number(diameter) || 3), 3, 10);
    const half = diameter, scale = diameter / 3;
    /* Everything the generator places has to fit inside the city. The perimeter
       wall sits just outside `half`, so water, roads and plots are all kept in by
       a margin rather than being allowed to spill into the surround. */
    const INNER = half - .12;
    const riverExtent = INNER;
    const rand = random(seed);
    /* Channel width is drawn per seed: some cities get a narrow canal with tight
       banks, others a broad river with long embankments. All river, bridge and
       promenade geometry derives from `bank`, so the parts stay consistent. It is
       drawn before the meander so the amplitude can be budgeted against the room
       the channel actually has. */
    const bankVar = rand();
    const bank = BANK * (.62 + bankVar * .95);      // 0.62x .. 1.57x of the default
    const channel = bank + WATER;
    const phase = rand() * 6.28;
    /* The meander amplitude is capped against the space actually available, so the
       channel always stays inside the city instead of wandering past the wall. */
    const lateral = clamp(INNER - channel - .30, .35, 4.2);
    const amplitude = Math.min((.52 + rand() * .46) * scale, lateral * .78);
    const bend = Math.min((.06 + rand() * .18) * scale, lateral * .22);
    const samples = Math.ceil(riverExtent * 48);
    const riverSamples = Array.from({length: samples + 1}, (_, i) => {
      const z = -riverExtent + i * riverExtent * 2 / samples;
      return {x: Math.sin(z * .7 / scale + phase) * amplitude + Math.sin(z * 1.7 / scale + phase) * bend, z};
    });
    const lakeData = [], facilityData = [];
    if (diameter > 5) {
      const count = diameter >= 8 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        const sign = i === 0 ? -1 : 1, x = sign * half * .61, z = (i === 0 ? 1 : -1) * half * .37;
        const rx = .76 + diameter * .052 + rand() * .15, rz = .67 + diameter * .065 + rand() * .13, phase2 = rand() * 6.28;
        const points = Array.from({length: 64}, (_, j) => {
          const angle = j * Math.PI / 32, r = 1 + .10 * Math.sin(angle * 3 + phase2) + .06 * Math.cos(angle * 5 - phase2);
          return {x: x + Math.cos(angle) * rx * r, z: z + Math.sin(angle) * rz * r};
        });
        lakeData.push({x, z, rx, rz, points});
      }
      for (const [type, sign] of [['factory', -1], ['power', 1]]) {
        const w = 2.35, d = 1.86, rad = Math.hypot(w, d) / 2;
        /* The site must sit fully inside the city: `half - d/2 - margin` keeps the
           gable from overhanging the perimeter wall. */
        const inset = d / 2 + .10;
        const siteX = Math.min(Math.abs(sign * (half - 1.5)), INNER - w / 2 - .10) * sign;
        for (const zSign of [-1, 1]) {
          const site = {type, x: siteX, z: zSign * (INNER - inset), w, d};
          if (riverDistance(site.x, site.z, riverSamples) < channel + rad + .12) continue;
          if (!lakeClear(site.x, site.z, rad, lakeData)) continue;
          if (facilityData.some(b => overlaps(site, b, .25))) continue;
          facilityData.push(site);
          break;
        }
      }
    }
    /* Roads first, then structures, then buildings. Order matters: the road set is
       final (and connectivity-filtered) before crossings are searched, so an
       overpass can never be left spanning a road that was later discarded. */
    const roads = buildRoadNetwork(rand, half, scale, riverSamples, bank, lakeData, facilityData);
    const bridgeData = placeBridges(roads, riverSamples, bank, lakeData, rand);
    /* Two kinds of structure share one list, distinguished by `type`:
         type 0/1/2 - river bridges (arch / cable-stayed / girder) that carry a
                      road over the water and ramp back down onto the bank roads;
         type 3     - overpasses that carry one road over another where the two
                      networks cross, ramping down onto the road beneath. */
    const structureData = [...bridgeData];
    for (const x of roadCrossings(roads)) {
      if (x.skew < 28 || x.w < .62) continue;
      if (structureData.some(s => dist2(s.x, s.z, x.x, x.z) < .60 * .60)) continue;
      structureData.push({...x, lo: x.w / 2, d: .20});
    }
    /* A radius test is too coarse here: the footprints are squares rotated to
       face the street, and a corner can reach well past the inscribed radius. The
       exact rotated-rectangle test is used so no plot grows over a deck. */
    const onBridge = (footprint, pad) =>
      structureData.some(b => overlaps(footprint, {x: b.x, z: b.z, w: b.w, d: b.d, angle: b.angle}, pad));

    const buildingData = [], parkData = [];
    const attempts = 2600;
    for (let i = 0; i < attempts; i++) {
      const x = (rand() - .5) * (half * 2 - .62), z = (rand() - .5) * (half * 2 - .62);
      const w = .31 + rand() * .135, d = .31 + rand() * .135;
      const footprint = {x, z, w: w + .085, d: d + .085};
      const radius = Math.hypot(footprint.w, footprint.d) / 2;
      if (Math.abs(x) + footprint.w / 2 > half - .12 || Math.abs(z) + footprint.d / 2 > half - .12) continue;
      if (riverDistance(x, z, riverSamples) < channel + radius + .025) continue;
      if (!lakeClear(x, z, radius, lakeData)) continue;
      if (roadClearance(x, z, roads) < radius) continue;
      if (onBridge(footprint, .075)) continue;
      if (facilityData.some(b => overlaps(footprint, b, .12))) continue;
      if (buildingData.some(b => overlaps(footprint, b.footprint, .065))) continue;
      if (rand() < .12) {
        if (parkData.some(p => overlaps(footprint, p, .06))) continue;
        parkData.push(footprint);
        continue;
      }
      const center = Math.exp(-(x * x + z * z) / (3.4 * scale));
      const h = Math.round((.28 + rand() * .58 + center * (.35 + rand() * 1.05)) / FLOOR) * FLOOR;
      buildingData.push({x, z, w, d, h, footprint, style: Math.floor(rand() * 4), palette: Math.floor(rand() * 4), detailSeed: Math.floor(rand() * 0xffffffff)});
    }
    if (!parkData.length && buildingData.length > 1) parkData.push(buildingData.pop().footprint);
    return {seed, diameter, half, INNER, riverSamples, bank, channel, roads, bridgeData, structureData,
      buildingData, parkData, lakeData, facilityData,
      buildings: buildingData.length, bridges: bridgeData.length,
      overpasses: structureData.filter(s => s.type === 3).length,
      boundary: ['城墙', '河岸', '高山'][Math.floor(rand() * 3)], version: 6};
  }
  function tiers(b) {
    const base = .116;
    if (b.style === 2) return [{bottom:base,top:base+b.h,w0:b.w,d0:b.d,w1:b.w*.58,d1:b.d*.68,x:0,z:0}];
    const n = b.style === 0 ? 1 : b.style === 1 ? 3 : 2;
    return Array.from({length:n},(_,i) => ({bottom:base+b.h*i/n,top:base+b.h*(i+1)/n,
      w0:b.w*(1-i*.18),d0:b.d*(1-i*.18),w1:b.w*(1-i*.18),d1:b.d*(1-i*.18),
      x:b.style===3 ? i*b.w*.07 : 0,z:0}));
  }
  function ring(w,d) {
    const c = Math.min(w,d)*.13;
    return [[-w/2+c,-d/2],[w/2-c,-d/2],[w/2,-d/2+c],[w/2,d/2-c],
      [w/2-c,d/2],[-w/2+c,d/2],[-w/2,d/2-c],[-w/2,-d/2+c]];
  }
  function surface(t, edge, u, y) {
    const v = clamp((y-t.bottom)/(t.top-t.bottom),0,1);
    const r = ring(t.w0+(t.w1-t.w0)*v,t.d0+(t.d1-t.d0)*v);
    const a = r[edge], b = r[(edge+1)%8];
    return [t.x+a[0]+(b[0]-a[0])*u,y,t.z+a[1]+(b[1]-a[1])*u];
  }

  // Opaque PBR geometry is merged per material. Thousands of real facade panels
  // retain depth testing without thousands of separate scene draw calls.
  class Batch {
    constructor(mats) { this.mats=mats; this.data=new Map(); this.matrix=new THREE.Matrix4(); }
    geometry(g,key) {
      if (g.index) { const source=g; g=g.toNonIndexed(); source.dispose(); }
      g.applyMatrix4(this.matrix);
      if (!this.data.has(key)) this.data.set(key,{p:[],n:[],uv:[]});
      const dest=this.data.get(key);
      for (const [attr,out] of [['position','p'],['normal','n'],['uv','uv']]) {
        const values=g.getAttribute(attr)?.array;
        if (values) for (let i=0;i<values.length;i++) dest[out].push(values[i]);
        else if (attr==='uv') for (let i=0;i<g.getAttribute('position').count*2;i++) dest.uv.push(0);
      }
      g.dispose();
    }
    box(w,h,d,x,y,z,key,angle=0) {
      const g=new THREE.BoxGeometry(w,h,d); g.rotateY(angle); g.translate(x,y,z); this.geometry(g,key);
    }
    cylinder(rt,rb,h,x,y,z,key,sides=10) {
      const g=new THREE.CylinderGeometry(rt,rb,h,sides); g.translate(x,y,z); this.geometry(g,key);
    }
    quad(points,key,offset=0) {
      const a=new THREE.Vector3(...points[0]), b=new THREE.Vector3(...points[1]), c=new THREE.Vector3(...points[2]);
      const n=b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const p=[];
      for (const i of [0,1,2,0,2,3]) p.push(points[i][0]+n.x*offset,points[i][1]+n.y*offset,points[i][2]+n.z*offset);
      const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
      g.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,0,1,1,1,0,0,1,1,1,0],2));
      g.computeVertexNormals(); this.geometry(g,key);
    }
    beam(a,b,width,key) {
      const start=new THREE.Vector3(...a), end=new THREE.Vector3(...b), delta=end.clone().sub(start);
      const g=new THREE.CylinderGeometry(width,width,delta.length(),6);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize()));
      g.translate(...start.add(end).multiplyScalar(.5).toArray()); this.geometry(g,key);
    }
    at(x,z,angle=0) { this.matrix.makeRotationY(angle); this.matrix.setPosition(x,0,z); }
    finish(group) {
      for (const [key,data] of this.data) {
        const g=new THREE.BufferGeometry();
        g.setAttribute('position',new THREE.Float32BufferAttribute(data.p,3));
        g.setAttribute('normal',new THREE.Float32BufferAttribute(data.n,3));
        g.setAttribute('uv',new THREE.Float32BufferAttribute(data.uv,2));
        g.computeBoundingSphere();
        const mesh=new THREE.Mesh(g,this.mats[key]); mesh.name=key;
        mesh.castShadow=!['water','windowCool','windowWarm','accent','marking'].includes(key);
        mesh.receiveShadow=true; group.add(mesh);
      }
    }
  }
  function materials() {
    const mats={};
    const make=(key,color,roughness,metalness=.15,emissive=0,intensity=0) => {
      mats[key]=new THREE.MeshStandardMaterial({color,roughness,metalness,emissive,emissiveIntensity:intensity});
    };
    make('ground',0x18292e,.96,.04); make('earth',0x283237,1,.02);
    make('concrete',0x3e5159,.94,.04); make('concreteDark',0x25333c,.92,.06);
    make('metal',0x527078,.46,.62); make('frame',0x243e49,.52,.55);
    make('roof',0x263e48,.76,.28); make('asphalt',0x111d25,.96,.04);
    make('paving',0x3c5057,.89,.04); make('marking',0x93a699,.85,.04);
    make('glass0',0x285768,.28,.52); make('glass1',0x354a5c,.3,.5);
    make('glass2',0x335e64,.28,.5); make('glass3',0x4b535e,.34,.5);
    make('windowDark',0x122f3e,.23,.55);
    make('windowCool',0x508592,.3,.35,0x55c7e0,.28);
    make('windowWarm',0x998c69,.4,.15,0xffd7a2,.26);
    make('accent',0x489aaa,.36,.3,0x43cbdc,.6);
    make('amber',0xa47744,.5,.25,0xeab476,.36);
    make('water',0x103e4d,.21,.58); make('ripple',0x326575,.32,.5);
    make('soil',0x253a32,1,.02); make('leaf',0x36564b,.97,.03);
    make('leafLight',0x4b6757,.95,.02); make('trunk',0x41463d,1,0);
    make('rock',0x38444b,.99,.02); make('rockLight',0x49565a,1,.03);
    // Fine mineral variation breaks up the boundary and paving surfaces.
    const rand=random(4812), bytes=new Uint8Array(64*64*4);
    for(let i=0;i<bytes.length;i+=4) { const v=180+Math.floor(rand()*64); bytes.set([v,v,v,255],i); }
    const noise=new THREE.DataTexture(bytes,64,64); noise.wrapS=noise.wrapT=THREE.RepeatWrapping;
    noise.magFilter=THREE.LinearFilter; noise.minFilter=THREE.LinearMipmapLinearFilter; noise.generateMipmaps=true; noise.needsUpdate=true;
    for(const key of ['concrete','concreteDark','paving','rock','rockLight','earth']) { mats[key].map=noise; mats[key].roughnessMap=noise; }
    return mats;
  }
  function prism(batch,t,key) {
    for(let e=0;e<8;e++) batch.quad([surface(t,e,0,t.bottom),surface(t,e,0,t.top),surface(t,e,1,t.top),surface(t,e,1,t.bottom)],key);
    const r=ring(t.w1,t.d1), vertices=[];
    for(let e=0;e<8;e++) { const a=r[e],b=r[(e+1)%8]; vertices.push(t.x,t.top,t.z,t.x+b[0],t.top,t.z+b[1],t.x+a[0],t.top,t.z+a[1]); }
    const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.computeVertexNormals();batch.geometry(g,'roof');
  }
  function facadePatch(batch,t,e,u0,u1,y0,y1,key,offset=.0012) {
    batch.quad([surface(t,e,u0,y0),surface(t,e,u0,y1),surface(t,e,u1,y1),surface(t,e,u1,y0)],key,offset);
  }
  function tree(batch,x,z,size=.11) {
    batch.cylinder(.008,.011,size*.65,x,.035+size*.325,z,'trunk',6);
    const g=new THREE.IcosahedronGeometry(size*.48,1); g.scale(.85,1.35,.85);g.translate(x,.04+size,z);batch.geometry(g,'leaf');
    const crown=new THREE.IcosahedronGeometry(size*.3,1);crown.translate(x+size*.22,.04+size*1.22,z);batch.geometry(crown,'leafLight');
  }
  function tower(batch,b) {
    batch.at(b.x,b.z);
    const rand=random(b.detailSeed), ts=tiers(b);
    batch.box(b.footprint.w,.028,b.footprint.d,0,.014,0,'paving');
    batch.box(b.w+.025,.088,b.d+.025,0,.072,0,'concreteDark');
    // Ground-floor lobby, canopy, and columns are seated on a common ground datum.
    batch.box(b.w*.7,.06,.003,0,.068,-b.d/2-.014,'windowDark');
    for(const side of [-1,1]) batch.box(.014,.079,.023,side*b.w*.33,.069,-b.d/2-.014,'metal');
    batch.box(b.w*.75,.012,.055,0,.109,-b.d/2-.012,'metal');
    for(const t of ts) {
      prism(batch,t,'glass'+b.palette);
      for(let e=0;e<8;e++) {
        const a=surface(t,e,0,t.bottom),c=surface(t,e,1,t.bottom);
        const length=Math.hypot(c[0]-a[0],c[2]-a[2]);
        const cols=Math.max(1,Math.floor(length/.043));
        for(let y=t.bottom+.018;y<t.top-.025;y+=FLOOR) {
          const top=Math.min(y+.045,t.top-.014);
          for(let col=0;col<cols;col++) {
            const lit=rand(); const key=lit<.20?'windowWarm':lit<.45?'windowCool':'windowDark';
            facadePatch(batch,t,e,(col+.13)/cols,(col+.87)/cols,y,top,key);
          }
          facadePatch(batch,t,e,0,1,Math.min(y+.049,t.top-.008),Math.min(y+.055,t.top-.002),'frame',.0018);
        }
        // Structural mullions follow the very same tapered face as the glass.
        for(let col=0;col<=cols;col++) {
          const u=col/cols, half=.003/length;
          facadePatch(batch,t,e,Math.max(0,u-half),Math.min(1,u+half),t.bottom,t.top,'metal',.002);
        }
        facadePatch(batch,t,e,0,1,t.top-.012,t.top,'frame',.0024);
        const p=surface(t,e,0,t.top),q=surface(t,e,1,t.top);
        batch.beam([p[0],p[1]+.009,p[2]],[q[0],q[1]+.009,q[2]],.004,'metal');
      }
    }
    const roof=ts[ts.length-1], y=roof.top;
    batch.box(roof.w1*.34,.045,roof.d1*.32,roof.x,y+.0225,roof.z,'concreteDark');
    batch.box(roof.w1*.35,.007,roof.d1*.33,roof.x,y+.048,roof.z,'metal');
    for(const side of [-1,1]) {
      const x=roof.x+side*roof.w1*.25;
      batch.box(roof.w1*.13,.026,roof.d1*.25,x,y+.013,roof.z,'roof');
      batch.cylinder(.014,.014,.006,x,y+.029,roof.z,'frame',12);
      for(let k=0;k<3;k++) batch.box(roof.w1*.115,.002,.003,x,y+.027,roof.z+(k-1)*.012,'metal');
    }
    if(b.h>1.15) {
      batch.cylinder(.007,.011,.13,roof.x,y+.113,roof.z,'metal',8);
      batch.cylinder(.009,.009,.01,roof.x,y+.183,roof.z,'amber',8);
    }
    // Terrace planting is supported by the exposed lower roof slab.
    if(ts.length>1) for(let i=0;i<ts.length-1;i++) {
      const t=ts[i];
      batch.box(t.w1*.64,.016,.018,t.x,t.top+.008,t.z+t.d1/2-.024,'soil');
      batch.box(t.w1*.60,.014,.014,t.x,t.top+.023,t.z+t.d1/2-.024,'leaf');
    }
    batch.at(0,0);
  }
  function ribbon(batch,points,halfWidth,y,key) {
    const edges=points.map((p,i) => {
      const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)];
      const l=Math.hypot(b.x-a.x,b.z-a.z),nx=(b.z-a.z)/l,nz=-(b.x-a.x)/l;
      return [[p.x-nx*halfWidth,y,p.z-nz*halfWidth],[p.x+nx*halfWidth,y,p.z+nz*halfWidth]];
    });
    for(let i=1;i<edges.length;i++) batch.quad([edges[i-1][0],edges[i][0],edges[i][1],edges[i-1][1]],key);
    return edges;
  }
  function river(batch,layout) {
    const bank=layout.bank;
    // The water keeps its natural width; the bank margin is what varies, so the
    // promenade and embankment breathe while the channel stays a river.
    ribbon(batch,layout.riverSamples,bank,.012,'paving');
    ribbon(batch,layout.riverSamples,WATER,.017,'water');
    const edges=ribbon(batch,layout.riverSamples,WATER+.017,.012,'water');
    for(let i=1;i<edges.length;i++) for(let side=0;side<2;side++) {
      const a=edges[i-1][side],b=edges[i][side];
      // Retaining walls connect the water surface to the raised promenade.
      const quad=[[a[0],.012,a[2]],[a[0],.052,a[2]],[b[0],.052,b[2]],[b[0],.012,b[2]]];
      batch.quad(side===0?quad:quad.slice().reverse(),'concrete');
      batch.beam([a[0],.055,a[2]],[b[0],.055,b[2]],.01,'metal');
      if(i%4===0 && !layout.bridgeData.some(br=>Math.hypot(a[0]-br.x,a[2]-br.z)<br.w*.5+.3)) {
        batch.cylinder(.005,.006,.047,a[0],.08,a[2],'metal',6);
        batch.beam([a[0],.104,a[2]],[b[0],.104,b[2]],.003,'frame');
      }
    }
    const rand=random(layout.seed+62);
    // Rip-rap on the banks and a promenade railing, both scaled to the bank width.
    for(let i=0;i<Math.round(70*bank/.34);i++) {
      const p=layout.riverSamples[4+Math.floor(rand()*(layout.riverSamples.length-8))];
      const side=rand()<.5?-1:1, off=(WATER+.04+rand()*(bank-WATER-.02))*side;
      const g=new THREE.DodecahedronGeometry(.03+rand()*.04,0);g.scale(1,.6,1);
      g.translate(p.x+off,.014,p.z+off*.3);batch.geometry(g,'rock');
    }
    for(let i=8;i<layout.riverSamples.length-8;i+=10) {
      const p=layout.riverSamples[i],q=layout.riverSamples[i-1],n=layout.riverSamples[i+1];
      const l=Math.hypot(n.x-q.x,n.z-q.z)||1,nx=(n.z-q.z)/l,nz=-(n.x-q.x)/l;
      for(const side of [-1,1]) {
        if(layout.bridgeData.some(br=>Math.hypot(p.x-br.x,p.z-br.z)<br.w*.5+.22)) continue;
        const x=p.x+nx*(bank-.035)*side,z=p.z+nz*(bank-.035)*side;
        batch.box(.006,.075,.006,x,.05,z,'metal',0);
        batch.beam([p.x+nx*(bank-.09)*side,.088,p.z+nz*(bank-.09)*side],[p.x+nx*(bank+.03)*side,.088,p.z+nz*(bank+.03)*side],.0035,'metal');
      }
    }
    for(let i=0;i<95;i++) {
      const p=layout.riverSamples[4+Math.floor(rand()*(layout.riverSamples.length-8))];
      batch.box(.017+rand()*.055,.001,.002,p.x+(rand()-.5)*.32,.019,p.z,'ripple',rand()*.6);
    }
  }
  /* The deck spans exactly the water it crosses: `lo` and `hi` are measured to
     the far edge of the water on each side, so a wide channel gets a long bridge
     and a narrow one gets a short bridge. Approaches reach the bank road at
     y=.013, matching the carriageway height. */
  function bridge(batch,b) {
    const isOverpass=b.type===3;
    const lo=Math.max(b.lo,.26), hi=Math.max(b.w-b.lo,.26);
    const d=b.d, half=d/2;
    // Overpasses ride higher so the road below passes cleanly underneath, and
    // their approach ramps are longer to keep the same gentle grade.
    const deckY=isOverpass?.152:.098;
    const ramp=isOverpass?.72:.34;
    batch.at(b.x,b.z,b.angle);
    batch.box(lo+hi,deckY,d,0,deckY/2,0,'concreteDark');
    batch.box(lo+hi,.008,d-.05,0,deckY+.004,0,'asphalt');
    const rail=(z)=>{
      batch.box(lo+hi,.025,.02,0,deckY+.021,z,'metal');
      batch.beam([-lo,deckY+.078,z],[hi,deckY+.078,z],.005,'metal');
      if(b.type!==2) batch.box(lo+hi-.1,.006,.008,0,deckY+.055,z,'accent');
      for(let x=-lo+.05;x<hi;x+=.115) batch.box(.008,.058,.008,x,deckY+.048,z,'frame');
    };
    rail(half-.011); rail(-(half-.011));

    if(isOverpass) {
      // Grade separation: abutment walls, a pair of piers and a light parapet.
      for(const end of [-1,1]) batch.box(.10,deckY,d*.92,end*(lo-.05),deckY/2,0,'concrete');
      for(const side of [-1,1]) {
        batch.box(.055,deckY,d*.30,-lo*.30,deckY/2,side*(half-.05),'concrete');
        batch.box(.055,deckY,d*.30, hi*.30,deckY/2,side*(half-.05),'concrete');
      }
    } else if(b.type===0) {
      // Twin arches: short spans get one, long spans get two supports in the river.
      const arches=lo+hi>1.35?2:1;
      for(let k=0;k<arches;k++){
        const cx=-lo+(lo+hi)*(k+.5)/arches, span=(lo+hi)/arches;
        for(const side of [-1,1]) {
          const ribs=Math.max(3,Math.round(span/.16));
          for(let i=0;i<=ribs;i++){
            const t=i/ribs, x0=cx-span/2+span*t;
            const y=deckY-Math.sin(t*Math.PI)*Math.min(deckY-.02,.112);
            batch.box(.022,.022,d*.76,x0,y,0,'concrete');
          }
        }
      }
      if(arches===2) batch.box(.09,.09,d,-lo+(lo+hi)*.5,deckY/2,0,'concrete');
    } else if(b.type===1) {
      // Cable-stayed: pylon above the deck carrying fans of stays.
      const pylonX=(b.seedOdd?-1:1)*Math.min(.22,(lo+hi)*.16);
      batch.box(.085,.30,d*.5,pylonX,deckY+.15,0,'concrete');
      batch.box(.10,.02,d*.54,pylonX,deckY+.30,0,'metal');
      for(let i=0;i<6;i++){
        const y=deckY+.055+i*.042;
        for(const side of [-1,1]) {
          const x=side<0?-lo+.03:hi-.03;
          batch.beam([pylonX,y+ .02,side*(half-.05)],[x,deckY+.03,side*(half-.05)],.0026,'frame');
        }
      }
    } else {
      // Girder: shallow beams under the deck with a light truss above.
      for(const side of [-1,1]){
        batch.box(lo+hi,.045,.022,0,deckY-.028,side*(half-.028),'metal');
        for(let x=-lo+.06;x<hi;x+=.13) batch.box(.008,.038,.008,x,deckY+.036,side*(half-.011),'frame');
      }
      for(let x=-lo+.06;x<hi;x+=.26) batch.box(.014,.055,d*.5,x,deckY+.012,0,'frame');
      for(const x of [-lo*.55,hi*.55]) batch.box(.075,.085,d,x,deckY/2,0,'concrete');
    }

    /* Approach ramps on both ends, so the deck meets the ground carriageway
       instead of stopping in mid air. */
    for(const end of [-1,1]) {
      const x0=end*lo, x1=end*(lo+ramp);
      batch.quad(end>0
        ? [[x0,deckY+.004,-half],[x0,deckY+.004,half],[x1,.013,half],[x1,.013,-half]]
        : [[x1,.013,-half],[x1,.013,half],[x0,deckY+.004,half],[x0,deckY+.004,-half]],'asphalt');
      for(const edge of [-1,1]) {
        const q=[[x0,.007,edge*half],[x0,deckY+.004,edge*half],[x1,.013,edge*half],[x1,.007,edge*half]];
        batch.quad((end*edge)>0?q:q.slice().reverse(),'concreteDark');
      }
      if(!isOverpass) {
        batch.box(.07,.092,quarter(d),end*(lo+.06),.046,half-.075,'concrete');
        batch.box(.07,.092,quarter(d),end*(lo+.06),.046,-(half-.075),'concrete');
      }
    }
    function quarter(dd){ return Math.min(.05,dd*.22); }
    for(let x=-lo+.06;x<hi;x+=.14) batch.box(.055,.002,.005,x,deckY+.009,0,'marking');
    batch.at(0,0);
  }
  function roadAndLandscape(batch,layout) {
    const roads=layout.roads, bridges=layout.structureData;
    const rand=random(layout.seed+19);
    // Passing under a bridge would put tarmac through the deck, so the
    // carriageway is suppressed inside a bridge's footprint.
    const overBridge=(x,z)=>bridges.some(b=>Math.abs((x-b.x)*Math.cos(b.angle)+(z-b.z)*Math.sin(b.angle))<b.w/2+.02
      && Math.abs(-(x-b.x)*Math.sin(b.angle)+(z-b.z)*Math.cos(b.angle))<b.d/2+.02);
    const inRiver=(x,z)=>riverDistance(x,z,layout.riverSamples)<=layout.bank+.015;
    for(const road of roads) {
      const w=road.w, sw=road.sw;
      for(let i=1;i<road.path.length;i++) {
        const a=road.path[i-1], b=road.path[i];
        const len=Math.hypot(b.x-a.x,b.z-a.z);
        if(len<1e-4) continue;
        const angle=Math.atan2(b.z-a.z,b.x-a.x);
        const nx=(b.z-a.z)/len, nz=-(b.x-a.x)/len;
        const steps=Math.max(1,Math.round(len/.075));
        for(let s=0;s<steps;s++) {
          const t0=s/steps, t1=(s+1)/steps;
          const mx=a.x+(b.x-a.x)*(t0+t1)/2, mz=a.z+(b.z-a.z)*(t0+t1)/2;
          if(overBridge(mx,mz)) continue;
          const segLen=len/steps+.012;
          batch.at(mx,mz,angle);
          // A road that meets the river without a bridge stops at the bank.
          if(!inRiver(mx,mz)) {
            batch.box(segLen,.010,w,0,.005,0,'asphalt');
            if(road.rank<=1 && s%2===0) batch.box(.042,.002,.006,0,.011,0,'marking');
          }
          for(const side of [-1,1]) {
            const sx=mx+nx*(w/2+sw/2)*side, sz=mz+nz*(w/2+sw/2)*side;
            if(inRiver(sx,sz)) continue;
            batch.at(sx,sz,angle);
            batch.box(segLen,.008,sw,0,.005,0,'paving');
          }
        }
      }
      // Street furniture follows the road instead of a fixed grid.
      for(let i=1;i<road.path.length;i++) {
        const a=road.path[i-1], b=road.path[i];
        const len=Math.hypot(b.x-a.x,b.z-a.z);
        if(len<.3) continue;
        const angle=Math.atan2(b.z-a.z,b.x-a.x);
        const nx=(b.z-a.z)/len, nz=-(b.x-a.x)/len;
        for(let s=0;s<len;s+=.30) {
          const t=s/len;
          const px=a.x+(b.x-a.x)*t, pz=a.z+(b.z-a.z)*t;
          if(inRiver(px,pz)||overBridge(px,pz)) continue;
          const side=(Math.round(s/.30)%2)?1:-1;
          const lx=px+nx*(w/2+sw-.03)*side, lz=pz+nz*(w/2+sw-.03)*side;
          if(!lakeClear(lx,lz,.05,layout.lakeData)) continue;
          batch.at(lx,lz,angle);
          batch.box(.005,.075,.005,0,.048,0,'frame');
          batch.box(.032,.008,.012,.011,.089,0,'metal');
          batch.box(.022,.002,.008,.011,.085,0,'windowWarm');
          batch.at(0,0);
          if(rand()<.30) {
            const vx=px+nx*(w*.22)*side, vz=pz+nz*(w*.22)*side;
            if(inRiver(vx,vz)||overBridge(vx,vz)) continue;
            batch.at(vx,vz,angle);
            batch.box(.062,.017,.026,0,.019,0,'metal');
            batch.box(.030,.012,.024,0,.033,0,'windowDark');
            batch.box(.003,.004,.018,-.031,.021,0,'windowWarm');
            batch.at(0,0);
          }
          if(rand()<.22 && road.rank>=2) {
            const tx=px-nx*(w/2+sw+.085)*side, tz=pz-nz*(w/2+sw+.085)*side;
            if(inRiver(tx,tz)||overBridge(tx,tz)) continue;
            if(layout.buildingData.some(b=>overlaps({x:tx,z:tz,w:.12,d:.12},b.footprint))) continue;
            tree(batch,tx,tz,.085+rand()*.04);
          }
        }
      }
    }
    for(const park of layout.parkData) {
      batch.box(park.w,.024,park.d,park.x,.012,park.z,'paving');
      batch.box(park.w*.82,.009,park.d*.82,park.x,.029,park.z,'soil');
      for(let i=0;i<4;i++) tree(batch,park.x+(i%2-.5)*park.w*.55,park.z+(Math.floor(i/2)-.5)*park.d*.55,.13);
      batch.box(park.w*.8,.006,.035,park.x,.036,park.z,'paving');
      batch.box(.07,.019,.025,park.x+.08,.043,park.z+.04,'metal');
    }
  }
  function addLake(batch,lake) {
    const edge=lake.points;
    const fill=(scale,y,key)=>{
      const positions=[];
      for(let i=0;i<edge.length;i++){
        const a=edge[i],b=edge[(i+1)%edge.length];
        positions.push(lake.x,y,lake.z,lake.x+(b.x-lake.x)*scale,y,lake.z+(b.z-lake.z)*scale,lake.x+(a.x-lake.x)*scale,y,lake.z+(a.z-lake.z)*scale);
      }
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.computeVertexNormals();batch.geometry(g,key);
    };
    fill(1.09,.021,'soil');fill(1.055,.025,'paving');fill(1,.028,'water');
    edge.forEach((p,i)=>{
      if(i%4!==0)return;
      const x=lake.x+(p.x-lake.x)*1.10,z=lake.z+(p.z-lake.z)*1.10;
      tree(batch,x,z,.13);
      const q=edge[(i+1)%edge.length];
      batch.beam([p.x,.034,p.z],[q.x,.034,q.z],.016,'rock');
    });
    // Floating pontoons supported on low concrete piers at the lake shore.
    batch.box(.30,.033,.12,lake.x-lake.rx*.77,.058,lake.z,'metal');
    for(const s of [-1,1]) batch.cylinder(.018,.023,.045,lake.x-lake.rx*.77+s*.10,.030,lake.z,'concrete',8);
    for(let i=0;i<7;i++)batch.box(.008,.002,.118,lake.x-lake.rx*.77+(i-3)*.038,.076,lake.z,'frame');
  }
  function facility(batch,site) {
    batch.at(site.x,site.z);
    batch.box(site.w,.024,site.d,0,.012,0,'paving');
    batch.box(site.w-.08,.004,site.d-.08,0,.026,0,'asphalt');
    // Perimeter fence and service gates leave an accessible vehicle entrance.
    for(const side of [-1,1]) {
      batch.beam([-site.w/2,.13,side*site.d/2],[site.w/2,.13,side*site.d/2],.005,'metal');
      for(let x=-site.w/2;x<=site.w/2;x+=.15)batch.box(.008,.12,.008,x,.084,side*site.d/2,'frame');
    }
    if(site.type==='factory') {
      batch.box(1.16,.27,.67,-.30,.165,-.32,'concrete');
      batch.box(1.19,.025,.70,-.30,.312,-.32,'metal');
      for(let i=0;i<5;i++){
        const x=-.76+i*.23;
        batch.box(.19,.024,.62,x,.337,-.32,'roof');
        batch.box(.15,.009,.25,x,.354,-.32,'glass0');
        batch.box(.15,.13,.01,x,.106,.02,'frame');
        batch.box(.15,.012,.04,x,.177,.04,'amber');
        for(let y=.055;y<.16;y+=.024)batch.box(.144,.003,.014,x,y,.027,'metal');
      }
      for(let i=0;i<3;i++){
        const z=-.51+i*.38;
        batch.cylinder(.15,.15,.30,.71,.18,z,'metal',24);
        batch.cylinder(.154,.154,.014,.71,.34,z,'frame',24);
        batch.beam([.70,.08,z],[.29,.08,z],.012,'metal');
      }
      for(let i=0;i<4;i++){
        batch.box(.25,.12,.15,-.7+i*.33,.09,.55,i%2?'glass3':'glass2');
        for(let k=0;k<6;k++)batch.box(.008,.105,.154,-.81+i*.33+k*.037,.09,.55,'frame');
      }
      batch.box(.41,.16,.28,-.75,.11,-.70,'glass1');
      for(let i=0;i<3;i++)batch.box(.095,.045,.003,-.88+i*.125,.14,-.555,'windowCool');
    } else {
      // Cooling-tower shells follow a continuous curved profile, with open tops.
      for(const x of [-.65,-.13]) {
        const points=[new THREE.Vector2(.21,0),new THREE.Vector2(.19,.10),new THREE.Vector2(.14,.32),new THREE.Vector2(.15,.48),new THREE.Vector2(.18,.57)];
        const g=new THREE.LatheGeometry(points,28);g.translate(x,.03,-.27);batch.geometry(g,'concrete');
        batch.cylinder(.175,.17,.007,x,.555,-.27,'windowDark',28);
        const rim=new THREE.TorusGeometry(.18,.012,6,28);rim.rotateX(Math.PI/2);rim.translate(x,.60,-.27);batch.geometry(rim,'metal');
        for(let i=0;i<12;i++){const a=i*Math.PI/6;batch.box(.018,.075,.018,x+Math.cos(a)*.195,.067,-.27+Math.sin(a)*.195,'frame');}
      }
      batch.box(.58,.23,.64,.60,.145,-.28,'roof');
      for(let i=0;i<4;i++)batch.box(.56,.028,.055,.60,.274,-.53+i*.16,'metal');
      for(let i=0;i<4;i++) {
        const x=-.76+i*.43;
        for(let j=0;j<2;j++){
          const z=.31+j*.30;
          batch.box(.30,.014,.20,x,.125,z,'glass0');
          for(const side of [-1,1])batch.box(.018,.09,.15,x+side*.11,.074,z,'metal');
          for(let k=0;k<4;k++)batch.box(.002,.002,.19,x+(k-1.5)*.072,.134,z,'frame');
          batch.box(.30,.002,.002,x,.134,z,'accent');
        }
      }
      batch.beam([-.65,.1,.04],[.77,.1,.04],.016,'metal');
      batch.box(.26,.10,.19,.83,.08,.71,'concreteDark');
      for(let i=0;i<3;i++)batch.cylinder(.012,.016,.08,.76+i*.07,.17,.71,'metal',8);
    }
    batch.at(0,0);
  }
  function boundary(batch,layout) {
    const rand=random(layout.seed+101);
    const half=layout.half;
    // Perimeter sits outside the building plots, with real openings for water.
    for(let side=0;side<4;side++) for(let i=0;i<Math.ceil(half*2/.24);i++) {
      const along=-half+i*.24, angle=side*Math.PI/2;
      const x=Math.cos(angle)*along+Math.sin(angle)*(half+.08);
      const z=-Math.sin(angle)*along+Math.cos(angle)*(half+.08);
      if(riverDistance(x,z,layout.riverSamples)<layout.channel+.20) continue;
      batch.at(x,z,angle);
      if(layout.boundary==='城墙') {
        // Segmented concrete plinth, inset armour, coping and external buttress.
        // The central road on the east/west sides remains an open service gate.
        if(side%2===1 && Math.abs(along)<.23) continue;
        batch.box(.236,.055,.16,0,.0275,0,'concreteDark');
        batch.box(.226,.185,.085,0,.143,0,'concrete');
        batch.box(.189,.105,.008,0,.139,.047,'frame');
        batch.box(.155,.059,.01,0,.137,.052,'metal');
        batch.box(.239,.024,.115,0,.247,0,'concreteDark');
        batch.box(.031,.215,.055,-.10,.142,.061,'concreteDark');
        batch.box(.075,.055,.026,0,.046,.093,'concrete');
        if(i%3===0) batch.box(.034,.01,.012,0,.218,.05,'accent');
        if(i%6===0) {
          batch.box(.17,.055,.19,0,.28,0,'roof');
          batch.cylinder(.006,.012,.10,0,.357,0,'metal',8);
          batch.box(.035,.018,.018,0,.41,.005,'frame');
        }
      } else {
        batch.box(.238,.05,.15,0,.025,0,'concreteDark');
        batch.box(.238,.023,.16,0,.061,0,'paving');
        batch.cylinder(.005,.008,.065,-.10,.1,0,'metal',6);
        batch.beam([-.119,.132,0],[.119,.132,0],.004,'metal');
        if(i%3===0) {
          batch.box(.15,.04,.09,0,.052,.11,'concrete');
          batch.box(.14,.014,.08,0,.079,.11,'leaf');
        }
      }
    }
    batch.at(0,0);
    if(layout.boundary==='高山') {
      for(let side=0;side<4;side++) for(let i=0;i<Math.ceil((half*2+.8)/.62);i++) {
        const angle=side*Math.PI/2,along=-half-.4+i*.62;
        const x=Math.cos(angle)*along+Math.sin(angle)*(half+.65),z=-Math.sin(angle)*along+Math.cos(angle)*(half+.65);
        if(riverDistance(x,z,layout.riverSamples)<.75) continue;
        const h=.18+rand()*.46;
        const g=new THREE.IcosahedronGeometry(1,1),p=g.getAttribute('position');
        for(let j=0;j<p.count;j++) { const k=.83+rand()*.3;p.setXYZ(j,p.getX(j)*k*.33,Math.max(0,(p.getY(j)+.50)*h),p.getZ(j)*k*.31); }
        g.computeVertexNormals();g.translate(x,-.05,z);batch.geometry(g,i%2?'rock':'rockLight');
      }
    } else if(layout.boundary==='河岸') {
      // A landscaped coastal embankment has terraces and riprap, not a white rim.
      for(let i=0;i<70*half/3;i++) {
        const side=i%4,angle=side*Math.PI/2,along=(rand()-.5)*(half*2+.8);
        const x=Math.cos(angle)*along+Math.sin(angle)*(half+.35),z=-Math.sin(angle)*along+Math.cos(angle)*(half+.35);
        if(riverDistance(x,z,layout.riverSamples)<.51) continue;
        const g=new THREE.DodecahedronGeometry(.055+rand()*.06,0);g.scale(1,.65,1);g.translate(x,.002,z);batch.geometry(g,'rock');
      }
    }
  }
  function build(layout) {
    const group=new THREE.Group();group.name='Astra city';
    const batch=new Batch(materials());
    const span=layout.half*2;
    batch.box(span+1.9,.16,span+1.9,0,-.155,0,'earth');
    batch.box(span+1.5,.07,span+1.5,0,-.04,0,layout.boundary==='河岸'?'water':'ground');
    batch.box(span+.25,.06,span+.25,0,-.03,0,'ground');
    roadAndLandscape(batch,layout);river(batch,layout);
    for(const lake of layout.lakeData) addLake(batch,lake);
    for(const site of layout.facilityData) facility(batch,site);
    for(const b of layout.structureData) bridge(batch,b);
    for(const b of layout.buildingData) tower(batch,b);
    boundary(batch,layout);batch.finish(group);
    return group;
  }
  const api = {generate,build,tiers,surface,corners,overlaps,riverDistance,lakeClear,pointInLake,BANK};
  window.CityModel = api;
  return api;
})();
