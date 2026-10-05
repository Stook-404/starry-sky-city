/* Shared planning and geometry: all buildings, bridge approaches and banks use
   the same world coordinates. No transparent facades or screen-space outlines. */
const CityModel = (() => {
  const BANK = .34;
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
  function generate(seed,diameter=3) {
    diameter=clamp(Math.round(Number(diameter)||3),3,10);
    const half=diameter, scale=diameter/3, extent=half+.85;
    const cellCount=Math.floor((half*2-.4)/.7), step=(half*2-.4)/cellCount;
    const grid=Array.from({length:cellCount+1},(_,i)=>-half+.2+i*step);
    const rand = random(seed);
    const phase = rand() * 6.28, amplitude = (.52 + rand() * .46)*scale, bend = (.06 + rand() * .18)*scale;
    const samples=Math.ceil(extent*48);
    const riverSamples = Array.from({length:samples+1}, (_,i) => {
      const z = -extent + i * extent*2 / samples;
      return {x: Math.sin(z * .7/scale + phase) * amplitude + Math.sin(z * 1.7/scale + phase) * bend, z};
    });
    const bridgeCount=clamp(Math.round(diameter*1.2),4,9);
    let bridgeData = Array.from({length:bridgeCount},(_,i)=> (-half+.9)+i*(half*2-1.8)/(bridgeCount-1)).map(z => {
      const i = riverSamples.reduce((best,p,j) => Math.abs(p.z-z) < Math.abs(riverSamples[best].z-z) ? j : best, 1);
      const p = riverSamples[i], a = riverSamples[i-1], b = riverSamples[i+1];
      // THREE's Y rotation maps local +X onto the river's perpendicular.
      return { x:p.x, z:p.z, angle: Math.atan2(b.x-a.x,b.z-a.z), w:1.74, d:.22 };
    });
    const lakeData=[],facilityData=[];
    if(diameter>5) {
      const count=diameter>=8?2:1;
      for(let i=0;i<count;i++) {
        const sign=i===0?-1:1, x=sign*half*.61, z=(i===0?1:-1)*half*.37;
        const rx=.76+diameter*.052+rand()*.15, rz=.67+diameter*.065+rand()*.13, phase=rand()*6.28;
        const points=Array.from({length:64},(_,j)=>{
          const angle=j*Math.PI/32,r=1+.10*Math.sin(angle*3+phase)+.06*Math.cos(angle*5-phase);
          return {x:x+Math.cos(angle)*rx*r,z:z+Math.sin(angle)*rz*r};
        });
        lakeData.push({x,z,rx,rz,points});
      }
      for(const [type,sign] of [['factory',-1],['power',1]]) {
        const w=2.35,d=1.86;
        for(const zSign of [-1,1]) {
          const site={type,x:sign*(half-1.5),z:zSign*(half-1.35),w,d};
          if(riverDistance(site.x,site.z,riverSamples)<BANK+Math.hypot(w,d)/2+.12) continue;
          if(!lakeClear(site.x,site.z,Math.hypot(w,d)/2,lakeData)) continue;
          if(facilityData.some(b=>overlaps(site,b,.25))) continue;
          facilityData.push(site);break;
        }
      }
    }
    bridgeData = bridgeData.filter(b => lakeClear(b.x,b.z,Math.hypot(b.w,b.d)/2,lakeData));
    const buildingData = [], parkData = [];
    for (let ix=0;ix<cellCount;ix++) for (let iz=0;iz<cellCount;iz++) {
      const x = (grid[ix]+grid[ix+1])/2 + (rand()-.5)*.028;
      const z = (grid[iz]+grid[iz+1])/2 + (rand()-.5)*.028;
      const w = .31 + rand()*.135, d = .31 + rand()*.135;
      const footprint = {x,z,w:w+.085,d:d+.085};
      const radius = Math.hypot(footprint.w,footprint.d)/2;
      if (riverDistance(x,z,riverSamples) < BANK + radius + .025) continue;
      if (!lakeClear(x,z,radius,lakeData)) continue;
      if (facilityData.some(b=>overlaps(footprint,b,.12))) continue;
      if (bridgeData.some(b => overlaps(footprint,b,.055))) continue;
      if (buildingData.some(b => overlaps(footprint,b.footprint,.065))) continue;
      if (rand() < .13) { parkData.push(footprint); continue; }
      const center = Math.exp(-(x*x+z*z)/(3.4*scale));
      const h = Math.round((.28 + rand()*.58 + center*(.35+rand()*1.05))/FLOOR)*FLOOR;
      buildingData.push({x,z,w,d,h,footprint,style:Math.floor(rand()*4),palette:Math.floor(rand()*4),detailSeed:Math.floor(rand()*0xffffffff)});
    }
    if(!parkData.length && buildingData.length>1) parkData.push(buildingData.pop().footprint);
    return {seed,diameter,half,grid,riverSamples,bridgeData,buildingData,parkData,lakeData,facilityData,buildings:buildingData.length,bridges:bridgeData.length,
      boundary:['城墙','河岸','高山'][Math.floor(rand()*3)],version:4};
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
    ribbon(batch,layout.riverSamples,BANK,.012,'paving');
    ribbon(batch,layout.riverSamples,.255,.017,'water');
    const edges=ribbon(batch,layout.riverSamples,.272,.012,'water');
    for(let i=1;i<edges.length;i++) for(let side=0;side<2;side++) {
      const a=edges[i-1][side],b=edges[i][side];
      // Retaining walls connect the water surface to the raised promenade.
      const quad=[[a[0],.012,a[2]],[a[0],.052,a[2]],[b[0],.052,b[2]],[b[0],.012,b[2]]];
      batch.quad(side===0?quad:quad.slice().reverse(),'concrete');
      batch.beam([a[0],.055,a[2]],[b[0],.055,b[2]],.01,'metal');
      if(i%4===0 && !layout.bridgeData.some(br=>Math.hypot(a[0]-br.x,a[2]-br.z)<.55)) {
        batch.cylinder(.005,.006,.047,a[0],.08,a[2],'metal',6);
        batch.beam([a[0],.104,a[2]],[b[0],.104,b[2]],.003,'frame');
      }
    }
    const rand=random(layout.seed+62);
    for(let i=0;i<95;i++) {
      const p=layout.riverSamples[4+Math.floor(rand()*(layout.riverSamples.length-8))];
      batch.box(.017+rand()*.055,.001,.002,p.x+(rand()-.5)*.32,.019,p.z,'ripple',rand()*.6);
    }
  }
  function bridge(batch,b) {
    batch.at(b.x,b.z,b.angle);
    batch.box(1.04,.047,.22,0,.097,0,'concreteDark');
    batch.box(1.04,.008,.17,0,.125,0,'asphalt');
    for(const side of [-1,1]) {
      batch.box(1.055,.025,.025,0,.13,side*.102,'metal');
      batch.beam([-.52,.191,side*.103],[.52,.191,side*.103],.006,'metal');
      batch.box(.84,.006,.009,0,.168,side*.104,'accent');
      for(let x=-.48;x<.51;x+=.12) batch.box(.009,.065,.009,x,.16,side*.103,'frame');
      for(const end of [-1,1]) {
        batch.box(.065,.086,.024,end*.40,.044,side*.077,'concrete');
        // Bridge ramps meet the road at y=.013, with solid side faces.
        const x0=end*.52,x1=end*.86;
        const p=[[x0,.129,-.11],[x0,.129,.11],[x1,.013,.11],[x1,.013,-.11]];
        if(side===-1) {
          batch.quad(end>0?p:p.slice().reverse(),'asphalt');
          for(const edge of [-1,1]) {
            const q=[[x0,.007,edge*.11],[x0,.129,edge*.11],[x1,.013,edge*.11],[x1,.007,edge*.11]];
            batch.quad((end*edge)>0?q:q.slice().reverse(),'concreteDark');
          }
        }
      }
    }
    for(let x=-.43;x<.5;x+=.14) batch.box(.06,.002,.005,x,.131,0,'marking');
    batch.at(0,0);
  }
  function roadAndLandscape(batch,layout) {
    const open=(x,z,r=.07)=>riverDistance(x,z,layout.riverSamples)>BANK+r && lakeClear(x,z,r,layout.lakeData) && !layout.facilityData.some(b=>overlaps({x,z,w:r*2,d:r*2},b,.08)) && !layout.bridgeData.some(b=>overlaps({x,z,w:r*2,d:r*2},b));
    for(const axis of [0,1]) for(const line of layout.grid) for(let p=-layout.half+.03;p<layout.half;p+=.07) {
      const x=axis?p:line,z=axis?line:p;
      if(!open(x,z)) continue;
      batch.box(axis ? .071 : .115,.008,axis ? .115 : .071,x,.005,z,'asphalt');
      for(const side of [-1,1]) batch.box(axis ? .071 : .018,.017,axis ? .018 : .071,x+(axis?0:side*.070),.009,z+(axis?side*.070:0),'paving');
      if(Math.round((p+2.99)/.07)%3===0) batch.box(axis ? .037 : .005,.001,axis ? .005 : .037,x,.010,z,'marking');
    }
    const rand=random(layout.seed+19);
    for(const x of layout.grid) for(const z of layout.grid) {
      if(!open(x,z,.12)) continue;
      for(let k=0;k<4;k++) batch.box(.008,.001,.053,x+(k-1.5)*.017,.011,z+.103,'marking');
      const lx=x+.082,lz=z+.082;
      if(!open(lx,lz,.03)) continue;
      batch.cylinder(.005,.008,.105,lx,.058,lz,'frame',6);
      batch.box(.036,.009,.013,lx-.014,.112,lz,'metal');
      batch.box(.025,.002,.009,lx-.014,.108,lz,'windowWarm');
      if(rand()<.55 && !layout.buildingData.some(b=>overlaps({x:x-.13,z:z-.13,w:.14,d:.14},b.footprint))) tree(batch,x-.13,z-.13,.085+rand()*.04);
      // Low-profile vehicles scale to the carriageway, not to the towers.
      if(rand()<.38 && open(x-.025,z+.21,.05)) {
        batch.box(.027,.017,.065,x-.025,.019,z+.21,'metal');
        batch.box(.024,.012,.032,x-.025,.033,z+.212,'windowDark');
        batch.box(.019,.004,.003,x-.025,.021,z+.177,'windowWarm');
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
      if(riverDistance(x,z,layout.riverSamples)<BANK+.20) continue;
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
    for(const b of layout.bridgeData) bridge(batch,b);
    for(const b of layout.buildingData) tower(batch,b);
    boundary(batch,layout);batch.finish(group);
    return group;
  }
  const api = {generate,build,tiers,surface,corners,overlaps,riverDistance,lakeClear,pointInLake,BANK};
  window.CityModel = api;
  return api;
})();
