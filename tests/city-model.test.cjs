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
let buildings=0,facilities=0;const boundaries=new Set();
for(const km of [3,5,6,8,10]) for(let seed=1;seed<=50;seed++){
  const l=M.generate(seed*7919,km);boundaries.add(l.boundary);
  assert.equal(l.diameter,km);assert.ok(l.parkData.length);
  assert.equal(l.lakeData.length,km>5?(km>=8?2:1):0);
  if(km>5) assert.equal(l.facilityData.length,2,`Missing facility: ${km}km, seed ${seed}`);
  for(const b of l.bridgeData)assert.ok(M.lakeClear(b.x,b.z,Math.hypot(b.w,b.d)/2,l.lakeData),'Bridge approach lies in a lake');
  for(let i=0;i<l.buildingData.length;i++){
    const b=l.buildingData[i],f=b.footprint,r=Math.hypot(f.w,f.d)/2;buildings++;
    assert.ok(M.riverDistance(b.x,b.z,l.riverSamples)>=M.BANK+r+.024);
    assert.ok(M.lakeClear(b.x,b.z,r,l.lakeData));
    assert.ok(Math.abs(b.x)+f.w/2<l.half-.1 && Math.abs(b.z)+f.d/2<l.half-.1);
    for(let j=i+1;j<l.buildingData.length;j++)assert.ok(!M.overlaps(f,l.buildingData[j].footprint,.06));
    for(const br of l.bridgeData)assert.ok(!M.overlaps(f,br,.05));
    for(const site of l.facilityData)assert.ok(!M.overlaps(f,site,.11));
    for(const t of M.tiers(b)) for(const y of [t.bottom,(t.bottom+t.top)/2,t.top])for(let e=0;e<8;e++){
      const p=M.surface(t,e,.5,y);
      assert.ok(p.every(Number.isFinite));
      assert.ok(Math.abs(p[0])<f.w/2 && Math.abs(p[2])<f.d/2,'Facade leaves its reserved footprint');
    }
  }
  facilities+=l.facilityData.length;
}
assert.equal(boundaries.size,3);
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
