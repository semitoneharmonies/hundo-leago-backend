const {parentPort}=require('node:worker_threads');
setTimeout(()=>parentPort.postMessage({ok:true,result:{highestLevelCompleted:0,cumulativeTimeMs:null,completed:false}}),250);
