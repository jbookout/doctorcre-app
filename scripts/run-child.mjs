import { spawn } from 'node:child_process';

const FORCE_KILL_GRACE_MS=1000;

export function runChild(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,options);
    let forwardedSignal=null,settled=false,killTimer=null,killDeadline=Infinity;
    const forceKill=()=>{try{child.kill('SIGKILL');}catch{}};
    const armForceKill=delay=>{
      const deadline=Date.now()+delay;
      if(deadline>=killDeadline) return;
      clearTimeout(killTimer);
      killDeadline=deadline;
      killTimer=setTimeout(forceKill,delay);
      killTimer.unref();
    };
    const forward=signal=>{
      forwardedSignal??=signal;
      try{child.kill(signal);}catch{}
      armForceKill(FORCE_KILL_GRACE_MS);
    };
    const onSigint=()=>forward('SIGINT');
    const onSigterm=()=>forward('SIGTERM');
    const cleanup=()=>{
      clearTimeout(killTimer);
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
    if(Number.isFinite(options.timeout)&&options.timeout>0)
      armForceKill(options.timeout+FORCE_KILL_GRACE_MS);
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
