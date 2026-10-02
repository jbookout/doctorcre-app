import { writeFile, mkdir } from 'node:fs/promises';
import { createDocContext, docAnswer, contextualSuggestions, DOC_PAGES } from '../js/doc-context-model.js';
import { docEvaluationSet } from '../test/fixtures/doc-context-evaluations.mjs';
import { DOC_EVALUATED_PAGES } from '../js/doc-accuracy.js';
const pages=[];
for (const item of docEvaluationSet) {
 const context=createDocContext({page:item.page});context.finish(context.begin(item.method,item.args),item.payload);context.select(item.kind,item.recordId);
 const questions=[
  {prompt:item.prompt,query:item.question,expected:item.answer,recordId:item.recordId},
  {prompt:'What is the name of this exact record?',query:'Name',expected:item.recordName,recordId:item.recordId},
  {prompt:'What is its unrecorded cost?',query:'Unrecorded cost',expected:null,recordId:item.recordId},
  {prompt:'What is the next step for an unavailable record?',query:'Next step',expected:null,recordId:'demo-absent'},
 ];
 const answers=questions.map(q=>{const answer=docAnswer(context.snapshot(),{recordId:q.recordId,kind:item.kind,question:q.query});return {...q,expectedState:q.expected===null?'unknown':'answered',actual:answer.value,actualState:answer.state};});
 const passed=answers.filter(q=>q.actual===q.expected && q.actualState===q.expectedState).length;
 pages.push({page:item.page,passed,total:answers.length,percent:100*passed/answers.length,questions:answers});
}
const report={schema:'doctorcre-doc-factual-evaluation.v1',method:'Deterministic scoped record-field lookup; not natural-language generation or an LLM score',pages,total:pages.reduce((n,p)=>n+p.total,0),passed:pages.reduce((n,p)=>n+p.passed,0),unsupportedPages:Object.keys(DOC_PAGES).filter(p=>!DOC_EVALUATED_PAGES.includes(p)),suggestionGate:'Evaluated page AND current authorized response AND exact identity/revision binding; unsupported pages have no proactive suggestions'};
if(pages.some(page=>page.percent!==100)) throw new Error('Doc context evaluation failed');
await mkdir(new URL('../test-artifacts/w8/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-artifacts/w8/context-accuracy.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed}/${report.total} (${100*report.passed/report.total}%) across ${pages.length} supported page families`);
