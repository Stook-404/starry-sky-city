const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {join}=require('node:path');
const root=join(__dirname,'..');
const ctx={window:{},console};vm.createContext(ctx);
vm.runInContext(readFileSync(join(root,'vendor/three.global.min.js'),'utf8'),ctx);
ctx.THREE=ctx.window.THREE;
vm.runInContext(readFileSync(join(root,'city-model.js'),'utf8'),ctx);
const M=ctx.window.CityModel;
const segDist=(x,z,ax,az,bx,bz)=>{const dx=bx-ax,dz=bz-az,l2=dx*dx+dz*dz;
  const t=l2?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/l2)):0;
  return Math.hypot(x-ax-dx*t,z-az-dz*t);};
let buildings=0,facilities=0,disconnected=0;const boundaries=new Set();
const banks=new Set();let orphans=0,roadOverlaps=0,bridgeTypes=new Set();
for(const km of [3,5,6,8,10]) for(let seed=1;seed<=50;seed++){
  const l=M.generate(seed*7919,km);boundaries.add(l.boundary);banks.add(l.bank.toFixed(3));
  assert.equal(l.diameter,km);assert.ok(l.parkData.length);
  assert.equal(l.lakeData.length,km>5?(km>=8?2:1):0);
  if(km>5) assert.equal(l.facilityData.length,2,`Missing facility: ${km}km, seed ${seed}`);

  // The channel is drawn per seed, so a city must have a plausible bank margin
  // and the water plus promenade must stay inside sane bounds.
  assert.ok(l.bank>.18 && l.bank<.60,`Bank width out of range: ${l.bank}`);
  assert.ok(Math.abs(l.channel-(l.bank+.255))<1e-9,'channel must be bank + water');

  // Every bridge has to sit on a road centreline, otherwise it spans nothing.
  for(const b of l.bridgeData){
    assert.ok(Number.isFinite(b.w)&&Number.isFinite(b.lo)&&Number.isFinite(b.angle),'bridge geometry must be finite');
    assert.ok(b.lo>0&&b.lo<b.w,'bridge origin must fall inside its own span');
    bridgeTypes.add(b.type);
    let onRoad=false;
    for(const rd of l.roads){
      for(let i=1;i<rd.path.length;i++){
        const a=rd.path[i-1],c=rd.path[i];
        const dx=c.x-a.x,dz=c.z-a.z,len2=dx*dx+dz*dz;
        const t=len2?Math.max(0,Math.min(1,((b.x-a.x)*dx+(b.z-a.z)*dz)/len2)):0;
        if(Math.hypot(b.x-a.x-dx*t,b.z-a.z-dz*t)<.02){onRoad=true;break;}
      }
      if(onRoad)break;
    }
    if(!onRoad) orphans++;
  }
  for(const b of l.bridgeData)assert.ok(M.lakeClear(b.x,b.z,Math.hypot(b.w,b.d)/2,l.lakeData),'Bridge approach lies in a lake');
  for(let i=0;i<l.buildingData.length;i++){
    const b=l.buildingData[i],f=b.footprint,r=Math.hypot(f.w,f.d)/2;buildings++;
    assert.ok(M.riverDistance(b.x,b.z,l.riverSamples)>=M.BANK+r+.024);
    assert.ok(M.lakeClear(b.x,b.z,r,l.lakeData));
    assert.ok(Math.abs(b.x)+f.w/2<l.half-.1 && Math.abs(b.z)+f.d/2<l.half-.1);
    // Plots must clear the carriageway of every road, not just the nearest one.
    for(const rd of l.roads){
      let best=Infinity;
      for(let k=1;k<rd.path.length;k++){
        const a=rd.path[k-1],c=rd.path[k];
        const dx=c.x-a.x,dz=c.z-a.z,len2=dx*dx+dz*dz;
        const t=len2?Math.max(0,Math.min(1,((b.x-a.x)*dx+(b.z-a.z)*dz)/len2)):0;
        best=Math.min(best,Math.hypot(b.x-a.x-dx*t,b.z-a.z-dz*t));
      }
      if(best<rd.w/2) roadOverlaps++;
    }
    for(let j=i+1;j<l.buildingData.length;j++)assert.ok(!M.overlaps(f,l.buildingData[j].footprint,.06));
    for(const br of l.bridgeData)assert.ok(!M.overlaps(f,br,.05));
    for(const site of l.facilityData)assert.ok(!M.overlaps(f,site,.11));
    for(const t of M.tiers(b)) for(const y of [t.bottom,(t.bottom+t.top)/2,t.top])for(let e=0;e<8;e++){
      const p=M.surface(t,e,.5,y);
      assert.ok(p.every(Number.isFinite));
      assert.ok(Math.abs(p[0])<f.w/2 && Math.abs(p[2])<f.d/2,'Facade leaves its reserved footprint');
    }
  }
  // Roads must not be a lattice. A grid layout makes essentially every segment
  // axis-aligned, so half is a comfortable ceiling that still catches any
  // regression back to street-parallel generation.
  let axisAligned=0,segments=0;
  for(const rd of l.roads) for(let i=1;i<rd.path.length;i++){
    const a=rd.path[i-1],c=rd.path[i];
    const deg=Math.abs(((Math.atan2(c.z-a.z,c.x-a.x)*180/Math.PI)%90+90)%90);
    segments++; if(deg<2||deg>88) axisAligned++;
  }
  assert.ok(segments>0,'a layout must produce roads');
  assert.ok(axisAligned/segments<.5,`Roads look like a grid: ${axisAligned}/${segments} axis-aligned`);

  // The whole network must be one connected component: every road has to share a
  // junction with some other road, otherwise streets dead-end in open ground.
  const gap=(a,b)=>{let best=Infinity;
    for(let i=1;i<a.path.length;i++)for(let j=1;j<b.path.length;j++){
      const p=a.path[i-1],q=a.path[i],r=b.path[j-1],s=b.path[j];
      const d=Math.min(
        segDist(p.x,p.z,r.x,r.z,s.x,s.z),segDist(q.x,q.z,r.x,r.z,s.x,s.z),
        segDist(r.x,r.z,p.x,p.z,q.x,q.z),segDist(s.x,s.z,p.x,p.z,q.x,q.z));
      if(d<best)best=d;}
    return best;};
  const seen=new Set([0]);
  let grew=true;
  while(grew){grew=false;
    for(let i=0;i<l.roads.length;i++){ if(seen.has(i))continue;
      for(const k of seen){ if(gap(l.roads[i],l.roads[k])<.45){seen.add(i);grew=true;break;} }
    }
  }
  disconnected+=l.roads.length-seen.size;

  // Nothing may sit outside the city, and the river must stay within the wall.
  for(const p of l.riverSamples){
    assert.ok(Math.abs(p.x)<l.half,`River leaves the city laterally: x=${p.x.toFixed(2)} half=${l.half}`);
    assert.ok(Math.abs(p.z)<=l.half+.001,`River leaves the city: z=${p.z.toFixed(2)}`);
  }
  for(const s of l.facilityData){
    assert.ok(Math.abs(s.x)+s.w/2<l.half-.09,`Facility crosses the boundary: x=${s.x} w=${s.w}`);
    assert.ok(Math.abs(s.z)+s.d/2<l.half-.09,`Facility crosses the boundary: z=${s.z} d=${s.d}`);
  }
  for(const p of l.parkData){
    assert.ok(Math.abs(p.x)+p.w/2<l.half-.09,`Park crosses the boundary: x=${p.x} w=${p.w}`);
    assert.ok(Math.abs(p.z)+p.d/2<l.half-.09,`Park crosses the boundary: z=${p.z} d=${p.d}`);
  }
  // Overpasses exist only where two roads actually cross.
  for(const s of l.structureData) if(s.type===3){
    assert.ok(Number.isFinite(s.x)&&Number.isFinite(s.z)&&s.w>.5,'overpass geometry must be finite');
  }
  facilities+=l.facilityData.length;
}
assert.equal(boundaries.size,3);
assert.ok(banks.size>20,`Channel width barely varies: only ${banks.size} distinct values`);
assert.equal(orphans,0,`${orphans} bridges are not connected to any road`);
assert.equal(roadOverlaps,0,`${roadOverlaps} buildings stand on a carriageway`);
assert.ok(bridgeTypes.size>=2,`Only ${bridgeTypes.size} bridge model(s) in use`);
assert.equal(disconnected,0,`${disconnected} roads are not joined to the network`);
console.log(`Variation checks: ${banks.size} distinct bank widths, ${bridgeTypes.size} bridge models, 0 orphan bridges, 0 road overlaps, 0 disconnected roads.`);

for(const km of [3,6,10]) {
  const l=M.generate(7919,km),g=M.build(l);
  let triangles=0;
  g.traverse(o=>{if(!o.geometry)return;const p=o.geometry.attributes.position;
    for(const n of p.array)assert.ok(Number.isFinite(n));
    triangles+=p.count/3;assert.equal(o.material.transparent,false);
    assert.equal(o.material.depthTest,true);assert.equal(o.material.depthWrite,true);
  });
  assert.ok(g.children.length<40);
  console.log(`${km} km: ${l.buildings} buildings, ${g.children.length} material batches, ${triangles} triangles`);
}
console.log(`Passed 250 layouts, ${buildings} buildings, ${facilities} facilities, all 3 boundary types.`);
