import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { partSectionForCode } from '@/lib/sections/stock'
import { setOcWasmUrl } from './occInit'
import { detectStepSection } from './readSection'
const require = createRequire(import.meta.url)
setOcWasmUrl(require.resolve('replicad-opencascadejs/wasm'))
const DIR = process.env.HEX_DIR!
function pin(x:number,y:number,p:[number,number][]){let s=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const[xi,yi]=p[i]as[number,number];const[xj,yj]=p[j]as[number,number];if(yi>y!==yj>y&&x<((xj-xi)*(y-yi))/(yj-yi)+xi)s=!s}return s}
function near(x:number,y:number,p:[number,number][],tol=1.5){if(pin(x,y,p))return true;for(let i=0,j=p.length-1;i<p.length;j=i++){const[ax,ay]=p[j]as[number,number];const[bx,by]=p[i]as[number,number];const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy;let t=l>0?((x-ax)*dx+(y-ay)*dy)/l:0;t=Math.max(0,Math.min(1,t));if(Math.hypot(x-(ax+t*dx),y-(ay+t*dy))<=tol)return true}return false}
function bbox(p:[number,number][]){const xs=p.map(q=>q[0]),ys=p.map(q=>q[1]);return [Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)]}
describe('outline vs catalogue roll', () => { it('s', async () => {
  for (const n of [10,11,12,15]) {
    const f=`12095, ITEM ${n}, 200UB25, 1 OFF[C].STEP`
    const bytes=new Uint8Array(readFileSync(`${DIR}/${f}`))
    const guess=await detectStepSection(bytes); if(!guess?.outline)continue
    const cat=partSectionForCode(guess.code,guess.dims??[])?.points; if(!cat)continue
    const outer=guess.outline.outer
    // centre both, then fine rotation sweep of outline -> catalogue
    const [ox0,ox1,oy0,oy1]=bbox(outer); const ocx=(ox0+ox1)/2, ocy=(oy0+oy1)/2
    const [cx0,cx1,cy0,cy1]=bbox(cat); const ccx=(cx0+cx1)/2, ccy=(cy0+cy1)/2
    const pts=outer.map(([x,y])=>[x-ocx,y-ocy] as [number,number])
    let bestDeg=0,bestFit=-1
    for(let deg=-10;deg<=10;deg+=0.1){const t=deg*Math.PI/180,c=Math.cos(t),s=Math.sin(t);let ff=0;for(const[u,v]of pts){const tu=u*c-v*s+ccx,tv=u*s+v*c+ccy;if(near(tu,tv,cat))ff++}if(ff/pts.length>bestFit){bestFit=ff/pts.length;bestDeg=deg}}
    console.log(`ITEM ${n}: outline->cat best roll=${bestDeg.toFixed(2)}° fit=${(bestFit*100).toFixed(0)}% outlineN=${outer.length} bboxW=${(ox1-ox0).toFixed(0)} H=${(oy1-oy0).toFixed(0)} catW=${(cx1-cx0).toFixed(0)} H=${(cy1-cy0).toFixed(0)}`)
  }
  expect(true).toBe(true)
},600000)})
