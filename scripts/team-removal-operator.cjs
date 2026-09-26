'use strict';

// Explicit operator invocation only; this file is never imported by startup.
// Preview and verification are query-only. Mutations require a reviewed
// preview plus the bounded approval envelope on stdin; there is no default.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const Database=require('better-sqlite3');
const op=require('../src/operations/teamRemovalRecovery');
const {TARGET}=require('../src/operations/teamRemovalExecutionAuthorization');
const [command,file]=process.argv.slice(2);
function open(readonly){
 const db=new Database(fs.realpathSync(file),{readonly,fileMustExist:true,timeout:1000});db.pragma('foreign_keys=ON');if(readonly)db.pragma('query_only=ON');return db;
}
function output(value){process.stdout.write(JSON.stringify(value,null,2)+'\n');}
try{
 assert(['preview','verify','approval-template','apply','rollback'].includes(command),'Use preview | verify | approval-template | apply | rollback DB');
 assert(file,'An explicit database path is required');
 if(['preview','verify','approval-template'].includes(command)){
  const db=open(true);
  try{
   const changes=db.prepare('SELECT total_changes() n').get().n;
   if(command==='verify')output(op.verifyApplied(db));
   else {
    const manifest=op.preview(db);
    if(command==='preview')output({manifest,manifestHash:op.hash(manifest)});
    else {
     const codeHashes=Object.fromEntries(['teamRemovalExecutionAuthorization.js','teamRemovalRecovery.js','teamRemovalWriteFence.js'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../src/operations',name))).digest('hex')]));
     output({manifest,approval:{format:'team-removal-execution-approval-v1',approved:false,approvedBy:null,approvalReference:null,operations:['apply','rollback'],issuedAtMs:null,expiresAtMs:null,...TARGET,buildId:process.env.RENDER_GIT_COMMIT||null,manifestHash:op.hash(manifest),scopeHash:op.hash(op.SCOPE),operationId:op.SCOPE.operationId,schema:op.SCOPE.schema,codeHashes}});
    }
   }
   assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
  }finally{db.close();}
 }else{
  const bytes=fs.readFileSync(0);assert(bytes.length>0&&bytes.length<=1024*1024,'A bounded explicit approval envelope is required on stdin');
  const envelope=JSON.parse(bytes.toString('utf8'));
  assert(envelope&&typeof envelope==='object'&&Object.keys(envelope).sort().join('|')==='approval|manifest','Expected exactly manifest and approval');
  assert(envelope.approval,'Approval is required');
  const readonly=open(true);
  try{
   const hash=command==='apply'?op.hash(envelope.manifest):op.receipt(readonly)?.previewHash;
   assert.equal(op.hash(envelope.manifest),hash,'Compensation must name the original reviewed preview');
   op.requireExecution(readonly,envelope.approval,command,Date.now(),hash);
  }finally{readonly.close();}
  const db=open(false);
  try{output(command==='apply'?op.apply(db,{manifest:envelope.manifest,authorization:envelope.approval}):op.rollback(db,{authorization:envelope.approval}));}
  finally{db.close();}
 }
}catch(error){output({status:'refused',error:error.code||error.message,message:error.message,details:error.details});process.exitCode=1;}
