import { spawn } from 'node:child_process';

export function runChild(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,options);
    let forwardedSignal=null,settled=false;
    const forward=signal=>{
      forwardedSignal??=signal;
      try{child.kill(signal);}catch{}
    };
    const onSigint=()=>forward('SIGINT');
    const onSigterm=()=>forward('SIGTERM');
    const cleanup=()=>{
      process.off('SIGINT',onSigint);
      process.off('SIGTERM',onSigterm);
    };
    const settle=action=>{
      if(settled) return;
      settled=true;
      cleanup();
      action();
    };
    process.on('SIGINT',onSigint);
    process.on('SIGTERM',onSigterm);
    child.once('error',error=>settle(()=>reject(error)));
    child.once('close',(code,signal)=>{
      settle(()=>{
        if(code===0&&!forwardedSignal) return resolve();
        const error=Error(`child process failed (${signal??forwardedSignal??code})`);
        error.code=code;
        error.signal=signal??forwardedSignal;
        reject(error);
      });
    });
  });
}
