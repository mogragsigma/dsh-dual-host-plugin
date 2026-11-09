// Public native Session messages only. An ask-user result is a human answer only
// when paired with that Session's actual native call; ordinary tools stay data.
export function humanMessages(agent){
 const messages=agent.session?.deriveMessages?.();
 if(!Array.isArray(messages))throw Error('HUMAN_REQUEST_UNAVAILABLE');
 const calls=new Map(),answered=new Set(),result=[];
 for(const m of messages){
  if(m.role==='user'&&m.source?.kind==='user'){result.push(m);continue;}
  if(m.role==='assistant'&&m.source?.kind==='model')for(const b of m.content??[]){
   if(b.type!=='tool-call'||b.name!=='ask_user_question')continue;
   try{const a=JSON.parse(b.arguments);if(Array.isArray(a.questions)&&a.questions.length)calls.set(b.id,a.questions);}catch{}
  }
  const late=m.role==='user'&&m.source?.kind==='user-question-reply'&&m.source.outcome==='answered';
  const tool=m.role==='tool'&&m.source?.kind==='tool'&&m.source.callId===m.toolCallId&&!m.isError;
  if(!late&&!tool)continue;
  const callId=late?m.source.callId:m.toolCallId,questions=calls.get(callId);
  if(!questions){if(late)throw Error('NATIVE_ANSWER_CONTEXT_MISSING');continue;}if(answered.has(callId))continue;
  let payload;try{payload=JSON.parse(m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n'));}catch{throw Error('NATIVE_ANSWER_UNSUPPORTED');}
  if(payload.pending===true)continue;
  const answers=payload.answers;
  if(!Array.isArray(answers)||answers.length!==questions.length||new Set(answers.map(a=>a.id)).size!==answers.length||
   answers.some(a=>!questions.some(q=>q.id===a.id)||!Array.isArray(a.selected)||a.selected.some(s=>typeof s!=='string'||!questions.find(q=>q.id===a.id).options?.some(o=>o.label===s))||a.custom!==undefined&&typeof a.custom!=='string'))throw Error('NATIVE_ANSWER_UNSUPPORTED');
  answered.add(callId);
  if(!answers.some(a=>a.selected.length||a.custom?.trim()))continue; // Skipped is not consent.
  const text=JSON.stringify({kind:'native-user-answers',call_id:callId,questions:questions.map(q=>({id:q.id,question:q.question})),answers});
  result.push({id:m.id,role:'user',source:{kind:'native-question-answer'},content:[{type:'text',text}]});
 }
 return result;
}
