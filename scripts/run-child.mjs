import { spawn } from 'node:child_process';

// full-main's deadline allows its leader this long to close browsers before
// escalating to the group; a forwarded signal must not cut that window short.
export const GRACEFUL_SHUTDOWN_MS=15_000;
const FORCE_KILL_GRACE_MS=1000;
const FORWARDED_SIGNAL_GRACE_MS=GRACEFUL_SHUTDOWN_MS-FORCE_KILL_GRACE_MS;

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
      armForceKill(FORWARDED_SIGNAL_GRACE_MS);
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
