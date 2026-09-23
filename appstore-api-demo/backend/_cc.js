require('dotenv').config();
const targets=require('./targets');const appstore=require('./appstore');
const jwt=require('./jwt');const proxy=require('./proxy');const axios=require('axios');
(async()=>{
  const t=targets.all().find(x=>/cop chase/i.test(x.name));
  if(!t){console.log('Cop Chase not in apps.json. Targets:');targets.list().forEach(x=>console.log('  ['+x.id+'] '+x.name));return;}
  console.log(`[${t.id}] ${t.name} appId=${t.appId}`);
  const token=await jwt.getToken(t);
  const cfg={headers:{Authorization:`Bearer ${token}`},timeout:30000,...proxy.axiosProxyConfig(t.proxyUrl)};
  const g=u=>axios.get('https://api.appstoreconnect.apple.com'+u,cfg).then(r=>r.data);
  const exps=await appstore.listExperiments(t);
  console.log('experiments:',exps.map(e=>`${e.name}(${e.state})`).join(', ')||'none');
  for(const exp of exps){
    const trs=await appstore.getExperimentTreatments(t,exp.id);
    for(const tr of trs){
      if(!/a$/i.test(tr.name.trim())) continue; // only Treatment A
      console.log(`\n${tr.name} (${tr.id}):`);
      const locs=await appstore.getTreatmentLocalizations(t,tr.id);
      // find locales that HAVE screenshot sets with shots
      for(const loc of locs){
        const sets=(await g(`/v1/appStoreVersionExperimentTreatmentLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data||[];
        for(const s of sets){
          const shots=(await g(`/v1/appScreenshotSets/${s.id}/appScreenshots?limit=50`)).data||[];
          if(shots.length){
            const states={};shots.forEach(sh=>{const st=(sh.attributes.assetDeliveryState||{}).state;states[st]=(states[st]||0)+1;});
            console.log(`  ${loc.locale} / ${s.attributes.screenshotDisplayType}: ${shots.length} shot(s) ${JSON.stringify(states)}`);
          }
        }
      }
    }
  }
})().catch(e=>console.log('FAIL',e.response?e.response.status:e.message));
