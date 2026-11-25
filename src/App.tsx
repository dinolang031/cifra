import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Award, BarChart3, Check, CheckCircle2, ChevronRight, CircleHelp, Coins, Flame, Gamepad2, Gauge, Menu, Share2, Target, Timer, Trophy, UserRound, X } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { croatiaDateKey, challengeNumber, formatCroatianDate, formatPrice, formatCroatianDayCount, getQuestions, loadState, parseGuess, saveState, scoreGuess, newDaily, rolloverDaily, millisecondsUntilNextCroatiaDay, calculateStreak, guestStorageKey, userStorageKey, createGuestTimedDaily, startGuestTimedQuestion, resolveGuestTimedAnswer, resolveGuestTimedTimeout, completeGuestTimedDaily, remainingTimerMs, TIMED_QUESTION_DURATION_MS, type AppState, type DailyProgress, type TimedDailyProgress, type TimedQuestion } from './lib/game'
import { fetchCloudSnapshot, fetchDailyAttemptProgress, fetchTodayChallenge, fetchTodayGameplayMode, fetchPublicTimedGameplayEnabled, fetchTimedAttemptProgress, mergeCloudSnapshot, startDailyAttempt, startTimedDailyAttempt, startTimedQuestion, submitTimedAnswer, expireTimedQuestion, submitTimedResult, submitDailyAnswer, submitResult, type CloudChallenge, type CloudSnapshot, type CloudTimedQuestion, type CloudGameplayMode } from './lib/cloud'
import { supabase } from './lib/supabase'
import { AuthDialog } from './components/AuthDialog'
import './App.css'

const categoryClass=(category:string)=>category.toLowerCase().replaceAll(' ','-').replaceAll('č','c').replaceAll('ć','c').replaceAll('š','s').replaceAll('ž','z')
const scoreTier=(score:number)=>score===1000?'perfect':score>=800?'great':score>=400?'good':score>=100?'close':'low'
const dailyQuestions=(daily:DailyProgress)=>getQuestions(daily.questionIds).map((question,index)=>({...question,actualPrice:daily.actualPrices[index]??question.actualPrice}))
const timedQuestionFromCloud=(question:CloudTimedQuestion):TimedQuestion=>({position:question.question_position,questionId:question.question_id,question:question.question_text,itemName:question.item_name,category:question.category,unit:question.unit,location:question.location,outcome:question.outcome,startedAt:question.started_at,deadlineAt:question.deadline_at,serverNow:question.server_now,guess:question.guess,actualPrice:question.actual_price,score:question.question_score,explanation:question.explanation})
const timedDailyFromCloud=(date:string,challengeId:string,isDemo:boolean,questions:CloudTimedQuestion[],completed:boolean,serverRoundTripMs:number):TimedDailyProgress=>({date,challengeId,ruleset:'timed-v1',isDemo,questions:questions.map(timedQuestionFromCloud),guestQuestionIds:null,serverRoundTripMs,completed,updatedAt:Date.now()})
const projectTimedProgressToDaily=(daily:DailyProgress,progress:TimedDailyProgress):DailyProgress=>{
 const guesses=[...daily.guesses]
 const scores=[...daily.scores]
 const actualPrices=[...daily.actualPrices]
 for(const question of progress.questions){guesses[question.position-1]=question.guess;scores[question.position-1]=question.score;if(question.actualPrice!==null)actualPrices[question.position-1]=question.actualPrice}
 const latest=progress.questions[progress.questions.length-1]
 return {...daily,challengeId:progress.challengeId,actualPrices,guesses,scores,index:Math.min(Math.max(0,progress.questions.length-1),4),revealed:Boolean(latest&&latest.outcome!=='active'),completed:progress.completed,updatedAt:progress.updatedAt}
}
const attemptStorageKey=(userId:string,date:string)=>`cifra-attempt:${userId}:${date}`
const storeAttemptToken=(userId:string,date:string,token:string)=>{
  try{
    sessionStorage.setItem(attemptStorageKey(userId,date),token)
    return true
  }catch{
    return false
  }
}
const readAttemptToken=(userId:string,date:string)=>{
  try{
    return sessionStorage.getItem(attemptStorageKey(userId,date))??''
  }catch{
    return ''
  }
}
const getErrorMessage=(error:unknown,fallback='')=>{
  if(typeof error==='object'&&error!==null&&
    'message' in error&&typeof error.message==='string'){
    return error.message
  }
  return fallback
}
const cloudErrorMessage=(error:unknown,fallback:string)=>{
  const message=getErrorMessage(error,fallback)
  if(message.includes('challenge_attempt_submitted_too_soon'))return 'Rezultat se može poslati nakon kratkog vremena provedenog u izazovu. Pričekaj nekoliko sekundi i pokušaj ponovno.'
  if(message.includes('challenge_attempt_expired'))return 'Pokušaj je istekao. Vrati se na početnu i ponovno pokreni današnji izazov.'
  if(message.includes('challenge_attempt_already_submitted'))return 'Današnji rezultat je već spremljen.'
  if(typeof error==='object'&&error!==null&&'code' in error&&typeof error.code==='string'){
    return `Pogreška baze podataka (${error.code}): ${message}`
  }
  return message
}
const isNetworkFailure=(error:unknown)=>{
  if(typeof error==='object'&&error!==null&&
    'code' in error&&typeof error.code==='string'&&
    error.code!=='')return false

  return error instanceof TypeError||
    /network|fetch|offline/i.test(getErrorMessage(error))
}

function Logo(){return <Link className="logo" to="/" aria-label="CIFRA početna"><img src="/assets/logo.webp" alt="CIFRA"/></Link>}
function StreakBadge({count}:{count:number}){return <div className="streak-badge" aria-label={formatCroatianDayCount(count)} title={formatCroatianDayCount(count)}><Flame size={16} fill="currentColor"/><strong>{count}</strong><span>{formatCroatianDayCount(count).replace(/^\d+\s/, '')}</span></div>}

function Navbar({state,onHow,onAccount,signedIn}:{state:AppState;onHow:()=>void;onAccount:()=>void;signedIn:boolean}){const [open,setOpen]=useState(false);const isHome=useLocation().pathname==='/';return <header className={isHome?'navbar navbar-home':'navbar'}><div className="nav-inner">{!isHome&&<Logo/>}{!isHome&&<nav className={open?'nav-links open':'nav-links'}><Link to="/" onClick={()=>setOpen(false)}>Igra</Link><Link to="/statistika" onClick={()=>setOpen(false)}>Statistika</Link><button onClick={()=>{setOpen(false);onHow()}}>Kako igrati</button></nav>}<div className={isHome?'nav-actions home-nav-actions':'nav-actions'}><StreakBadge count={state.currentStreak}/>{isHome&&<><Link className="nav-icon" to="/statistika" aria-label="Statistika" title="Statistika"><BarChart3 size={19}/></Link><button className="nav-icon" onClick={onHow} aria-label="Kako igrati" title="Kako igrati"><CircleHelp size={19}/></button></>}<button className={isHome?'nav-icon home-account':'account-button'} onClick={onAccount} aria-label={isHome?(signedIn?'Moj račun':'Prijava'):undefined} title={isHome?(signedIn?'Moj račun':'Prijava'):undefined}>{isHome?<UserRound size={19}/>:signedIn?'Moj račun':'Prijava'}</button>{!isHome&&<button className="menu-button" onClick={()=>setOpen(!open)} aria-label="Izbornik">{open?<X/>:<Menu/>}</button>}</div></div></header>}

function Modal({open,onClose}:{open:boolean;onClose:()=>void}){useEffect(()=>{if(!open)return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose()};document.addEventListener('keydown',onKey);document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=''}},[open,onClose]);if(!open)return null;return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="how-title" onMouseDown={e=>e.stopPropagation()}><button className="modal-close" onClick={onClose} aria-label="Zatvori"><X/></button><p className="eyebrow">Upute</p><h2 id="how-title">Kako se igra?</h2><ol className="steps"><li><span>01</span><div><strong>5 novih pitanja svaki dan</strong><p>Dnevni izazov ostaje isti tijekom dana na ovom uređaju.</p></div></li><li><span>02</span><div><strong>20 sekundi za procjenu</strong><p>Unesi cijenu u eurima prije isteka vremena; nakon toga odgovor vrijedi 0 bodova.</p></div></li><li><span>03</span><div><strong>Što si bliže, više bodova</strong><p>Svako pitanje donosi do 1.000 bodova.</p></div></li><li><span>04</span><div><strong>Ostvari dnevni rezultat</strong><p>Danas možeš osvojiti najviše 5.000 bodova.</p></div></li></ol><button className="primary full" onClick={onClose}>JASNO</button></section></div>}

function Footer(){return <footer><div><Logo/><p>CIFRA — Koliko zapravo košta Hrvatska?</p></div><div className="footer-meta"><p>Svaki dan novi izazov.</p><small>Cijene u igri služe za zabavu i informativnu usporedbu. Mogu se razlikovati ovisno o lokaciji, vremenu i prodavatelju.</small><nav className="footer-links"><Link to="/privatnost">Privatnost</Link><Link to="/uvjeti">Uvjeti</Link></nav></div></footer>}

function Home({state,onStart,cloudNotice,challengeLoading,isDemo,timedMode}:{state:AppState;onStart:()=>Promise<'game'|'result'|false>;cloudNotice:string;challengeLoading:boolean;isDemo:boolean;timedMode:boolean}){const navigate=useNavigate();const today=state.daily;const timed=timedMode&&state.timedDaily?.date===today.date?state.timedDaily:null;const completed=timed?.completed??today.completed;const started=timed?timed.questions.length>0:today.guesses.some(v=>v!==null);const date=formatCroatianDate(croatiaDateKey());const progress=timed?timed.questions.filter(question=>question.outcome!=='active').length:today.guesses.filter(v=>v!==null).length;const total=timed?timed.questions.reduce((sum,question)=>sum+(question.score??0),0):today.scores.reduce<number>((a,b)=>a+(b||0),0);const readyToFinish=Boolean(timed&&timed.questions.length===5&&timed.questions.every(question=>question.outcome!=='active')&&!timed.completed);return <main className="home"><section className="hero-panel"><div className="hero-copy"><img className="hero-logo" src="/assets/logo.webp" alt="CIFRA"/><div className="challenge-heading"><span>IZAZOV #{challengeNumber(croatiaDateKey()).toString().padStart(3,'0')}</span></div><h1 className="hero-subtitle">KOLIKO ZAPRAVO KOŠTA HRVATSKA?</h1></div><div className="challenge-card"><div className="challenge-top"><strong>{date}</strong>{isDemo&&<b className="demo-pill">DEMO · ILUSTRATIVNE CIJENE</b>}</div><div className="challenge-stats"><div><strong>5</strong><span>pitanja</span></div><div><strong>20 s</strong><span>po pitanju</span></div><div><strong>{progress}/5</strong><span>napredak</span></div></div><div className="progress-track"><span style={{width:`${progress*20}%`}}/></div>{cloudNotice&&<p className="cloud-notice" role="status">{cloudNotice}</p>}{completed?<><div className="completed-score"><Trophy/><div><span>DANAŠNJI REZULTAT</span><strong>{total.toLocaleString('hr-HR')} / 5.000</strong></div></div><button className="primary full" onClick={()=>navigate('/rezultat')}>Pogledaj rezultat <ChevronRight size={18}/></button></>:<button className="primary full" disabled={challengeLoading} onClick={async()=>{const destination=await onStart();if(destination)navigate(destination==='result'?'/rezultat':'/igra')}}>{challengeLoading?'Učitavam izazov…':readyToFinish?'Završi izazov':started?'Nastavi izazov':'Započni današnji izazov'} {!challengeLoading&&<ChevronRight size={18}/>}</button>}</div></section><section className="home-bottom"><p>Svaki dan novi izazov s pitanjima koja se rotiraju.</p><div className="question-previews">{['Hrana','Piće','Prijevoz','Stanovanje','Zabava'].map((c,i)=><span key={c}><b>{i+1}</b>{c}</span>)}</div></section></main>}

function QuestionView({state,setState,onComplete,onAnswer,challengeLoading,isDemo}:{state:AppState;setState:Dispatch<SetStateAction<AppState>>;onComplete:(s:AppState)=>void;onAnswer:(date:string,index:number,guess:number,actualPrice:number)=>Promise<{daily:DailyProgress}>;challengeLoading:boolean;isDemo:boolean}){
 const navigate=useNavigate()
 const [raw,setRaw]=useState('')
 const [error,setError]=useState('')
 const [submitting,setSubmitting]=useState(false)
 const actionLock=useRef(false)
 const daily=state.daily
 const activeDate=useRef(daily.date)
 const list=dailyQuestions(daily)
 const question=list[daily.index]
 const activeQuestionId=question?.id
 useEffect(()=>{if(daily.completed)navigate('/rezultat');else if(!activeQuestionId)navigate('/')},[daily.completed,activeQuestionId,navigate])
 useEffect(()=>{actionLock.current=false},[daily.index,daily.revealed,daily.completed])
 useEffect(()=>{if(activeDate.current!==daily.date){activeDate.current=daily.date;navigate('/')}},[daily.date,navigate])
 if(challengeLoading)return <main className="empty-state"><p className="eyebrow">DANAŠNJI IZAZOV</p><h1>Učitavam izazov…</h1><p>Provjeravam pitanja i spremljeni rezultat.</p></main>
 if(daily.completed||!question)return null
 const guess=daily.guesses[daily.index]
 const score=daily.scores[daily.index]
 const actualPrice=daily.actualPrices[daily.index]??question.actualPrice
 const submit=async(e?:FormEvent)=>{
  e?.preventDefault()
  if(actionLock.current||daily.revealed||daily.guesses[daily.index]!==null||daily.completed)return
 if(daily.date!==croatiaDateKey()){setError('Današnji izazov je završio. Tvoj nedovršeni napredak ostaje spremljen.');return}
  const parsed=parseGuess(raw)
  if(parsed===null){setError('Upiši iznos do 1.000.000.000 € s najviše dvije decimale.');return}
  actionLock.current=true
  setSubmitting(true)
  setError('')
  try{
   const accepted=await onAnswer(daily.date,daily.index,parsed,actualPrice)
   setState(current=>current.daily.date!==daily.date||current.daily.index!==daily.index||current.daily.guesses[daily.index]!==null?current:{...current,daily:{...accepted.daily,revealed:true,updatedAt:Date.now()}})
  }catch{
   setError('Odgovor trenutačno nije moguće sinkronizirati. Pokušaj ponovno.')
   actionLock.current=false
  }finally{setSubmitting(false)}
 }
 const next=()=>{
  if(actionLock.current)return
  if(daily.date!==croatiaDateKey()){navigate('/');return}
  actionLock.current=true
  if(daily.index===4){
   const total=daily.scores.reduce<number>((a,b)=>a+(b||0),0)
   const exact=daily.scores.filter((_,i)=>daily.guesses[i]===daily.actualPrices[i]).length
   const avgError=daily.guesses.reduce<number>((sum,g,i)=>sum+(g===null?0:Math.abs(g-daily.actualPrices[i])/daily.actualPrices[i]),0)/5*100
   const today=daily.date
   const last=state.history[state.history.length-1]
   const streak=calculateStreak(last?.date??null,today,state.currentStreak)
   const updated={...state,currentStreak:streak,bestStreak:Math.max(state.bestStreak,streak),totalGames:state.totalGames+1,totalPoints:state.totalPoints+total,bestScore:Math.max(state.bestScore,total),exactGuesses:state.exactGuesses+exact,history:state.history.some(h=>h.date===today)?state.history:[...state.history,{date:today,score:total,accuracy:100-Math.min(100,avgError),exact}].slice(-30),daily:{...daily,completed:true,revealed:false,index:4,updatedAt:Date.now()}}
   setState(updated)
   onComplete(updated)
   navigate('/rezultat')
  }else{
   setRaw('')
   setError('')
   setState({...state,daily:{...daily,index:daily.index+1,revealed:false,updatedAt:Date.now()}})
  }
 }
 const difference=guess===null?0:guess-actualPrice
 return <main className="game-layout"><aside className="game-progress"><p>Pitanje</p><strong>{daily.index+1}<span>/5</span></strong><div className="step-list">{[0,1,2,3,4].map(i=><div className={i<daily.index?'step done':i===daily.index?'step active':'step'} key={i}><span>{i<daily.index?<Check size={12}/>:i+1}</span></div>)}</div></aside><section className="question-card"><div className="question-content"><span className={`category-badge ${categoryClass(question.category)}`}>{question.category}</span><p className="eyebrow">{question.location} · {question.unit}</p><h1>{question.question}</h1>{!daily.revealed?<><form onSubmit={submit}><label htmlFor="guess">Unesi svoju procjenu</label><div className="price-input"><span>€</span><input id="guess" inputMode="decimal" value={raw} onChange={e=>{setRaw(e.target.value);setError('')}} placeholder="0,00" autoFocus/><small>EUR</small></div>{error&&<p className="error" role="alert">{error}</p>}<button className="primary full" type="submit" disabled={submitting}>{submitting?'Spremam…':'Potvrdi procjenu'} <ChevronRight size={18}/></button></form>{isDemo&&<p className="demo-note">Ilustrativni demo podatak — cijena može biti zamijenjena provjerenim izvorom.</p>}</>:<div className="reveal"><p className="reveal-label">{isDemo?'ILUSTRATIVNA CIJENA':'STVARNA CIJENA'}</p><div className="actual-price">{formatPrice(actualPrice)}</div><div className="comparison"><div className="comparison-value"><span>TVOJA PROCJENA</span><strong>{formatPrice(guess||0)}</strong></div><div className={`comparison-value difference-value ${difference===0?'status exact':difference>0?'status high':'status low'}`}><span>RAZLIKA</span><strong>{difference===0?'Točna procjena':`${formatPrice(Math.abs(difference))} ${difference>0?'iznad':'ispod'}`}</strong></div></div><div className={`score-earned score-${scoreTier(score??0)}`}><strong>+{score?.toLocaleString('hr-HR')}</strong><span>BODOVA</span></div><div className="comparison-bar"><i style={{left:`${Math.min(96,Math.max(4,(Math.min(guess||0,actualPrice*2)/(actualPrice*2))*100))}%`}}/><b style={{left:`50%`}}/></div><p className="explanation">{question.explanation}</p>{isDemo&&<p className="demo-note">Ilustrativni demo podatak — cijena nije potvrđena kao tržišna cijena.</p>}<button className="primary full" onClick={next}>{daily.index===4?'Pogledaj rezultat':'Sljedeće pitanje'} <ChevronRight size={18}/></button></div>}</div></section></main>
}

function TimedQuestionView({state,onAnswer,onTimeout,onNext,onFinish,challengeLoading,isDemo}:{state:AppState;onAnswer:(date:string,position:number,guess:number)=>Promise<TimedDailyProgress>;onTimeout:(date:string,position:number)=>Promise<TimedDailyProgress>;onNext:(date:string,position:number)=>Promise<TimedDailyProgress>;onFinish:(date:string)=>Promise<void>;challengeLoading:boolean;isDemo:boolean}){
 const navigate=useNavigate()
 const [raw,setRaw]=useState('')
 const [error,setError]=useState('')
 const [remaining,setRemaining]=useState(0)
 const [pending,setPending]=useState(false)
 const actionLock=useRef(false)
 const timeoutLock=useRef(false)
 const retryTimeoutAt=useRef(0)
 const deadlinePerformance=useRef(0)
 const progress=state.timedDaily
 const question=progress?.questions[progress.questions.length-1]
 const active=question?.outcome==='active'
 const isServerTimed=progress?.ruleset==='timed-v1'
 const hasProgress=Boolean(progress)
 const timedCompleted=progress?.completed??false
 const scoreSoFar=progress?.questions.reduce((sum,current)=>sum+(current.outcome==='active'?0:current.score??0),0)??0

 useEffect(()=>{
  if(!question||!active)return
  const deadline=Date.parse(question.deadlineAt)
  const serverNow=question.serverNow?Date.parse(question.serverNow):null
  const networkAllowance=isServerTimed?Math.max(0,progress?.serverRoundTripMs??0)/2:0
  const remainingAtSync=serverNow===null?deadline-Date.now():deadline-serverNow-networkAllowance
  deadlinePerformance.current=performance.now()+Math.max(0,remainingAtSync)
  const tick=()=>{
   const nextRemaining=remainingTimerMs(deadlinePerformance.current,performance.now())
   setRemaining(nextRemaining)
   if(nextRemaining===0&&!timeoutLock.current&&performance.now()>=retryTimeoutAt.current){
    timeoutLock.current=true
    setPending(true)
    void onTimeout(progress.date,question.position).then(()=>setError('')).catch(reason=>{
     setError(cloudErrorMessage(reason,'Vrijeme je isteklo. Provjeravamo stanje sa servera prije otkrivanja odgovora.'))
     retryTimeoutAt.current=performance.now()+1000
    }).finally(()=>{
     timeoutLock.current=false
     setPending(false)
    })
   }
  }
  tick()
  const interval=window.setInterval(tick,100)
  return()=>window.clearInterval(interval)
 },[question,question?.questionId,question?.deadlineAt,question?.serverNow,question?.outcome,isServerTimed,progress?.serverRoundTripMs,progress?.date,active,onTimeout])

 useEffect(()=>{actionLock.current=false},[question?.position,question?.outcome,progress?.completed])
 useEffect(()=>{if(timedCompleted||state.daily.completed)navigate('/rezultat');else if(!hasProgress)navigate('/')},[timedCompleted,state.daily.completed,hasProgress,navigate])
 if(challengeLoading)return <main className="empty-state"><p className="eyebrow">DANAŠNJI IZAZOV</p><h1>Učitavam izazov…</h1><p>Provjeravam spremljeni vremenski pokušaj.</p></main>
 if(!progress||!question||progress.completed||state.daily.completed)return null

 const submit=async(event:FormEvent)=>{
  event.preventDefault()
  if(actionLock.current||!active||pending||remaining<=0)return
  const guess=parseGuess(raw)
  if(guess===null){setError('Upiši iznos do 1.000.000.000 € s najviše dvije decimale.');return}
  actionLock.current=true
  setPending(true)
  setError('')
  try{
   await onAnswer(progress.date,question.position,guess)
   setRaw('')
  }catch(reason){
   setError(cloudErrorMessage(reason,'Odgovor nije potvrđen. Provjeri vezu i pokušaj ponovno.'))
   actionLock.current=false
  }finally{setPending(false)}
 }

 const advance=async()=>{
  if(actionLock.current||!question||question.outcome==='active')return
  actionLock.current=true
  setPending(true)
  setError('')
  try{
   if(question.position===5)await onFinish(progress.date)
   else await onNext(progress.date,question.position+1)
  }catch(reason){
   setError(cloudErrorMessage(reason,'Sljedeće pitanje trenutačno nije dostupno. Pokušaj ponovno.'))
   actionLock.current=false
  }finally{setPending(false)}
 }

 const seconds=Math.ceil(remaining/1000)
 const timerTone=seconds>10?'safe':seconds>5?'warning':'urgent'
 const difference=question.guess===null||question.actualPrice===null?null:question.guess-question.actualPrice
 const questionScore=question.score??0
 return <main className="game-layout timed-game-layout">
  <aside className="game-progress">
   <p>Pitanje</p><strong>{question.position}<span>/5</span></strong>
   <div className="step-list">{[0,1,2,3,4].map(index=><div className={index<question.position-1?'step done':index===question.position-1?'step active':'step'} key={index}><span>{index<question.position-1?<Check size={12}/>:index+1}</span></div>)}</div>
   <div className="timed-score"><span>BODOVI</span><strong>{scoreSoFar.toLocaleString('hr-HR')}</strong></div>
  </aside>
  <section className="question-card timed-question-card">
   <div className="question-content">
    <div className="timed-question-meta"><span className={`category-badge ${categoryClass(question.category)}`}>{question.category}</span><span>{question.location} · {question.unit}</span></div>
    <p className="eyebrow">PITANJE {question.position} OD 5</p>
    <h1>{question.question}</h1>
    {active?<>
     <div className={`question-timer timer-${timerTone}`} aria-label={`Preostalo vrijeme: ${seconds} sekundi`}>
      <div className="timer-copy"><span><Timer size={16}/> Vrijeme</span><strong aria-live="polite">{seconds}<small>s</small></strong></div>
      <div className="timer-track" role="progressbar" aria-label="Preostalo vrijeme za odgovor" aria-valuemin={0} aria-valuemax={20} aria-valuenow={Math.min(20,seconds)}><i style={{width:`${Math.max(0,Math.min(100,remaining/TIMED_QUESTION_DURATION_MS*100))}%`}}/></div>
     </div>
     <form onSubmit={submit}>
      <label htmlFor="timed-guess">Unesi svoju procjenu</label>
      <div className="price-input"><span>€</span><input id="timed-guess" inputMode="decimal" value={raw} onChange={event=>{setRaw(event.target.value);setError('')}} placeholder="0,00" disabled={pending||remaining<=0}/><small>EUR</small></div>
      {error&&<p className="error" role="alert">{error}</p>}
      {remaining===0&&<p className="timed-pending" role="status">{pending?'Provjeravamo istek vremena…':'Veza je potrebna za potvrdu isteka vremena.'}</p>}
      <button className="primary full" type="submit" disabled={pending||remaining<=0}>{pending?'Provjeravam…':'Potvrdi procjenu'} <ChevronRight size={18}/></button>
     </form>
     {isDemo&&<p className="demo-note">Demo cijene su ilustrativne; nisu potvrđene tržišne cijene.</p>}
    </>:<>
     <div className={`timed-feedback ${question.outcome==='timed_out'?'feedback-timeout':'feedback-answered'}`}>
      <p className="reveal-label">{question.outcome==='timed_out'?'VRIJEME JE ISTEKLO':isDemo?'ILUSTRATIVNA CIJENA':'STVARNA CIJENA'}</p>
      <div className="actual-price">{question.actualPrice===null?'—':formatPrice(question.actualPrice)}</div>
      {question.outcome==='timed_out'?<p className="timeout-explanation">Nije poslana procjena · 0 bodova</p>:<div className="comparison">
       <div className="comparison-value"><span>TVOJA PROCJENA</span><strong>{question.guess===null?'—':formatPrice(question.guess)}</strong></div>
       <div className={`comparison-value difference-value ${difference===0?'status exact':difference!==null&&difference>0?'status high':'status low'}`}><span>RAZLIKA</span><strong>{difference===null?'—':difference===0?'Točna procjena':`${formatPrice(Math.abs(difference))} ${difference>0?'iznad':'ispod'}`}</strong></div>
      </div>}
      <div className={`score-earned score-${scoreTier(questionScore)}`}><strong>{questionScore.toLocaleString('hr-HR')}</strong><span>BODOVA</span></div>
      {question.explanation&&<p className="explanation">{question.explanation}</p>}
      {isDemo&&<p className="demo-note">Demo cijena je ilustrativna i nije potvrđena tržišna cijena.</p>}
     </div>
     {error&&<p className="error" role="alert">{error}</p>}
     <button className="primary full" onClick={()=>void advance()} disabled={pending}>{pending?'Spremam…':question.position===5?'Završi izazov':'Sljedeće pitanje'} <ChevronRight size={18}/></button>
    </>}
   </div>
  </section>
 </main>
}

function Results({state,syncStatus,syncMessage,onRetrySync,isDemo}:{state:AppState;syncStatus:'idle'|'saving'|'synced'|'error';syncMessage:string;onRetrySync:()=>void;isDemo:boolean}){
 const navigate=useNavigate()
 const [toast,setToast]=useState('')
 const list=dailyQuestions(state.daily)
 const total=state.daily.scores.reduce<number>((a,b)=>a+(b||0),0)
 const exact=state.daily.scores.filter((_,i)=>state.daily.guesses[i]===list[i].actualPrice).length
 const answered=list.reduce((count,_,index)=>count+(state.daily.guesses[index]===null?0:1),0)
 const avgError=list.reduce((sum,question,index)=>{
  const guess=state.daily.guesses[index]
  return sum+(guess===null?0:Math.abs(guess-question.actualPrice)/question.actualPrice)
 },0)/(answered||1)*100
 const avgErrorLabel=answered===0?'—':avgError>=100?'100%+':`${avgError.toFixed(0)}%`
 const message=total<1500?'Možda je vrijeme za češći odlazak u trgovinu.':total<2500?'Nije loše! Ali cijene su te malo iznenadile.':total<3500?'Dobro poznaješ svakodnevne cijene.':total<4500?'Pravi majstor cijena!':'Ti očito znaš koliko Hrvatska košta.'
 const boxes=state.daily.scores.map(score=>(score||0)>=850?'🟩':(score||0)>=650?'🟨':(score||0)>=350?'🟧':'⬜').join('')
 const share=async()=>{
  const text=`CIFRA #${challengeNumber(state.daily.date).toString().padStart(3,'0')}\n🏆 ${total.toLocaleString('hr-HR')} / 5.000\n${boxes}\nPogodio sam cijene u Hrvatskoj!\n🔥 ${formatCroatianDayCount(state.currentStreak)} u nizu\n\ncifra.hr`
  try{
   if(navigator.share)await navigator.share({title:'CIFRA rezultat',text})
   else{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
  }catch{
   try{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
   catch{const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
  }
 }
 if(!state.daily.completed)return <main className="empty-state"><BarChart3/><h1>Još nema rezultata</h1><p>Dovrši današnji izazov.</p><button className="primary" onClick={()=>navigate('/')}>Natrag na igru</button></main>
 return <main className="results"><section className={`result-hero result-hero-${scoreTier(total/5)}`}><p className="eyebrow">DANAŠNJI IZAZOV ZAVRŠEN</p><h1>SVAKA ČAST!</h1><p>{message}</p>{isDemo&&<p className="demo-result-note">Demo rezultat — cijene su ilustrativne i nisu potvrđene tržišne cijene.</p>}<div className={`result-score score-${scoreTier(total/5)}`}><strong>{total.toLocaleString('hr-HR')}</strong><span>/ 5.000</span></div><div className="score-grid">{state.daily.scores.map((score,index)=><div className={`score-grid-item score-${scoreTier(score??0)}`} key={index}><span>{index+1}</span><i style={{height:`${(score||0)/10}%`}}/></div>)}</div><button className="share-button" onClick={share}><Share2 size={18}/> Podijeli rezultat</button>{toast&&<div className="toast">{toast}</div>}{syncStatus==='saving'&&<p className="sync-status" role="status">Spremam rezultat na tvoj CIFRA račun…</p>}{syncStatus==='synced'&&<p className="sync-status" role="status">Rezultat i niz sinkronizirani su s tvojim računom.</p>}{syncStatus==='error'&&<div className="sync-error" role="alert"><p>{syncMessage}</p><button className="text-button" onClick={onRetrySync}>Pokušaj ponovno</button></div>}</section><section className="result-metrics"><div><strong>{Math.round(total/50)}%</strong><span>ostvareno</span></div><div><strong>{exact}</strong><span>točnih pogotka</span></div><div><strong>{avgErrorLabel}</strong><span>prosječna pogreška</span></div><div><strong>{state.currentStreak}</strong><span>trenutni niz</span></div><div><strong>{state.bestStreak}</strong><span>najbolji niz</span></div></section><section className="result-list"><div className="section-heading"><p className="eyebrow">Pregled odgovora</p><h2>Tvoj dnevni redoslijed</h2></div>{list.map((question,index)=>{const guess=state.daily.guesses[index];const difference=guess===null?null:guess-question.actualPrice;const questionScore=state.daily.scores[index]??0;return <article className="result-row" key={question.id}><span className="row-index">{index+1}</span><div className="row-main"><span className={`category-badge ${categoryClass(question.category)}`}>{question.category}</span><strong>{question.itemName}</strong></div><div className="row-prices"><span><small>Tvoja procjena</small><b>{guess===null?'—':formatPrice(guess)}</b></span><span><small>{isDemo?'Ilustrativna cijena':'Stvarna cijena'}</small><b>{formatPrice(question.actualPrice)}</b></span></div><div className={`row-diff ${difference===0?'exact':difference!==null&&difference>0?'high':difference===null?'':'low'}`}><small>Razlika</small><b>{difference===null?'—':difference===0?'Točno':difference>0?`+${formatPrice(difference)}`:`-${formatPrice(Math.abs(difference))}`}</b></div><strong className={`row-score score-${scoreTier(questionScore)}`}>{questionScore.toLocaleString('hr-HR')} <small>bodova</small></strong></article>})}</section></main>
}

function TimedResults({state,syncStatus,syncMessage,onRetrySync}:{state:AppState;syncStatus:'idle'|'saving'|'synced'|'error';syncMessage:string;onRetrySync:()=>void}){
 const [toast,setToast]=useState('')
 const progress=state.timedDaily
 const rows=progress?.questions??[]
 const total=rows.reduce((sum,question)=>sum+(question.score??0),0)
 const exact=rows.filter(question=>question.outcome==='answered'&&question.guess===question.actualPrice).length
 const answered=rows.filter(question=>question.outcome==='answered'&&question.guess!==null&&question.actualPrice!==null)
 const avgError=answered.length?answered.reduce((sum,question)=>sum+Math.abs((question.guess??0)-(question.actualPrice??0))/(question.actualPrice??1),0)/answered.length*100:null
 const avgErrorLabel=avgError===null?'—':avgError>=100?'100%+':`${avgError.toFixed(0)}%`
 const message=total<1500?'Možda je vrijeme za češći odlazak u trgovinu.':total<2500?'Nije loše! Ali cijene su te malo iznenadile.':total<3500?'Dobro poznaješ svakodnevne cijene.':total<4500?'Pravi majstor cijena!':'Ti očito znaš koliko Hrvatska košta.'
 const boxes=rows.map(question=>question.outcome==='timed_out'?'⬛':(question.score??0)>=850?'🟩':(question.score??0)>=650?'🟨':(question.score??0)>=350?'🟧':'⬜').join('')
 const share=async()=>{
  const text=`CIFRA #${challengeNumber(progress?.date??state.daily.date).toString().padStart(3,'0')}\n🏆 ${total.toLocaleString('hr-HR')} / 5.000\n${boxes}\nIgrao sam CIFRA izazov!\n🔥 ${formatCroatianDayCount(state.currentStreak)} u nizu\n\ncifra.hr`
  try{
   if(navigator.share)await navigator.share({title:'CIFRA rezultat',text})
   else{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
  }catch{
   try{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
   catch{const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}
  }
 }
 if(!state.daily.completed||!progress?.completed)return <main className="empty-state"><BarChart3/><h1>Još nema rezultata</h1><p>Dovrši današnji izazov.</p><Link className="primary" to="/">Natrag na igru</Link></main>
 return <main className="results">
  <section className={`result-hero result-hero-${scoreTier(total/5)}`}>
   <p className="eyebrow">DANAŠNJI IZAZOV ZAVRŠEN</p><h1>SVAKA ČAST!</h1><p>{message}</p>
   {progress.isDemo&&<p className="demo-result-note">Demo rezultat — cijene su ilustrativne i nisu potvrđene tržišne cijene.</p>}
   <div className={`result-score score-${scoreTier(total/5)}`}><strong>{total.toLocaleString('hr-HR')}</strong><span>/ 5.000</span></div>
   <div className="score-grid">{rows.map(question=><div className={`score-grid-item score-${scoreTier(question.score??0)}`} key={question.position}><span>{question.position}</span><i style={{height:`${(question.score??0)/10}%`}}/></div>)}</div>
   <button className="share-button" onClick={()=>void share()}><Share2 size={18}/> Podijeli rezultat</button>
   {toast&&<div className="toast" role="status">{toast}</div>}
   {syncStatus==='saving'&&<p className="sync-status" role="status">Spremam rezultat na tvoj CIFRA račun…</p>}
   {syncStatus==='synced'&&<p className="sync-status" role="status">Rezultat i niz sinkronizirani su s tvojim računom.</p>}
   {syncStatus==='error'&&<div className="sync-error" role="alert"><p>{syncMessage}</p><button className="text-button" onClick={onRetrySync}>Pokušaj ponovno</button></div>}
  </section>
  <section className="result-metrics"><div><strong>{Math.round(total/50)}%</strong><span>ostvareno</span></div><div><strong>{exact}</strong><span>točnih pogotka</span></div><div><strong>{avgErrorLabel}</strong><span>prosječna pogreška</span></div><div><strong>{state.currentStreak}</strong><span>trenutni niz</span></div><div><strong>{state.bestStreak}</strong><span>najbolji niz</span></div></section>
  <section className="result-list"><div className="section-heading"><p className="eyebrow">Pregled odgovora</p><h2>Tvoj dnevni redoslijed</h2></div>
   {rows.map(question=>{
    const difference=question.guess===null||question.actualPrice===null?null:question.guess-question.actualPrice
    const score=question.score??0
    return <article className={`result-row ${question.outcome==='timed_out'?'result-row-timeout':''}`} key={question.questionId}>
     <span className="row-index">{question.position}</span>
     <div className="row-main"><span className={`category-badge ${categoryClass(question.category)}`}>{question.category}</span><strong>{question.itemName}</strong></div>
     <div className="row-prices"><span><small>Tvoja procjena</small><b>{question.outcome==='timed_out'?'Vrijeme isteklo':question.guess===null?'—':formatPrice(question.guess)}</b></span><span><small>{progress.isDemo?'Ilustrativna cijena':'Stvarna cijena'}</small><b>{question.actualPrice===null?'—':formatPrice(question.actualPrice)}</b></span></div>
     <div className={`row-diff ${difference===0?'exact':difference!==null&&difference>0?'high':difference===null?'':'low'}`}><small>Razlika</small><b>{difference===null?'—':difference===0?'Točno':difference>0?`+${formatPrice(difference)}`:`-${formatPrice(Math.abs(difference))}`}</b></div>
     <strong className={`row-score score-${scoreTier(score)}`}>{score.toLocaleString('hr-HR')} <small>bodova</small></strong>
    </article>
   })}
  </section>
 </main>
}

function Stats({state}:{state:AppState}){const avg=state.totalGames?Math.round(state.totalPoints/state.totalGames):0;const accuracyValues=state.history.map(entry=>entry.accuracy).filter((value):value is number=>value!==null);const avgAccuracy=accuracyValues.length?Math.round(accuracyValues.reduce((sum,value)=>sum+value,0)/accuracyValues.length):null;const cards=[{label:'Odigrane igre',value:state.totalGames,icon:Gamepad2},{label:'Trenutni niz',value:state.currentStreak,icon:Flame},{label:'Najbolji niz',value:state.bestStreak,icon:Trophy},{label:'Ukupno bodova',value:state.totalPoints.toLocaleString('hr-HR'),icon:Coins},{label:'Prosječan rezultat',value:avg.toLocaleString('hr-HR'),icon:Gauge},{label:'Najbolji rezultat',value:state.bestScore.toLocaleString('hr-HR'),icon:Award},{label:'Prosječna točnost',value:avgAccuracy===null?'—':`${avgAccuracy}%`,icon:Target},{label:'Točni pogoci',value:state.exactGuesses,icon:CheckCircle2}];return <main className="stats-page"><div className="stats-heading"><p className="eyebrow">Tvoj napredak</p><h1>Statistika</h1></div>{state.history.length?<><div className="stats-grid">{cards.map(({label,value,icon:Icon})=><article className="stat-card" key={label}><div className="stat-card-label"><span>{label}</span><Icon size={19} aria-hidden="true"/></div><strong>{value}</strong></article>)}</div><section className="chart-card"><div className="section-heading"><div><p className="eyebrow">Posljednjih 30 dana</p><h2>Dnevni rezultati</h2></div><strong>MAX 5.000</strong></div><div className="chart" role="img" aria-label="Dnevni rezultati u bodovima"><div className="chart-y-labels" aria-hidden="true"><span>5.000</span><span>2.500</span><span>0</span></div><div className="chart-lines" aria-hidden="true"><i/><i/><i/></div>{state.history.slice(-10).map(h=><div className="chart-bar-wrap" key={h.date} title={`${formatCroatianDate(h.date)} · ${h.score.toLocaleString('hr-HR')} bodova`}><div className="chart-bar" style={{height:`${h.score/50}%`}}><span>{h.score.toLocaleString('hr-HR')}</span></div><small>{h.date.slice(8)}</small></div>)}</div></section></>:<section className="empty-state"><BarChart3/><h1>Statistika se tek počinje pisati.</h1><p>Odigraj svoj prvi izazov i vrati se sutra.</p><Link className="primary" to="/">Započni igru</Link></section>}</main>}

function PrivacyPage(){return <main className="legal-page"><p className="eyebrow">Pravila</p><h1>Privatnost</h1><p>Registracija u CIFRA-i nije obavezna. Gostima se napredak i povijest spremaju lokalno u pregledniku. Ako izradite račun, Supabase obrađuje vašu email adresu, profil, odgovore i rezultate radi prijave i sinkronizacije među uređajima.</p><p>Rezultati računa mogu se čitati samo uz prijavu na pripadajući račun. Lokalni podaci ostaju na uređaju dok se ne očiste podaci preglednika.</p></main>}
function TermsPage(){return <main className="legal-page"><p className="eyebrow">Pravila</p><h1>Uvjeti korištenja</h1><p>Cijene i pitanja u aplikaciji služe za zabavu i informativnu usporedbu. Trenutni skup podataka označen je kao ilustrativni demo i nije potvrđeni skup tržišnih cijena.</p><p>Rezultati prijavljenih korisnika računaju se na poslužitelju iz spremljenih cijena izazova, ali to ne dokazuje da je igrač odgovarao bez pomoći ili automatizacije. Rezultati nisu natjecateljski rang.</p></main>}

function AppShell({children}:{children:ReactNode}){const isHome=useLocation().pathname==='/';return <div className={isHome?'app-shell app-shell-home':'app-shell app-shell-internal'}>{children}</div>}

export default function App(){
  const [state,setState]=useState<AppState>(()=>loadState())
  const [user,setUser]=useState<User|null>(null)
  const userRef=useRef(user)
  const attemptToken=useRef('')
  const [authOpen,setAuthOpen]=useState(false)
  const [passwordRecovery,setPasswordRecovery]=useState(false)
  const [how,setHow]=useState(false)
  const [cloudChallenge,setCloudChallenge]=useState<CloudChallenge|null>(null)
  const [cloudGameMode,setCloudGameMode]=useState<CloudGameplayMode|null>(null)
  const [cloudSnapshot,setCloudSnapshot]=useState<CloudSnapshot|null>(null)
  const [timedMode,setTimedMode]=useState(()=>Boolean(import.meta.env.DEV&&!supabase)||loadState(guestStorageKey).timedDaily?.ruleset==='guest-timed-v1')
  const [guestModeLoading,setGuestModeLoading]=useState(Boolean(supabase))
  const [cloudStatus,setCloudStatus]=useState<'guest'|'loading'|'ready'|'error'>(supabase?'loading':'guest')
  const [connectionEpoch,setConnectionEpoch]=useState(0)
  const [cloudMessage,setCloudMessage]=useState('')
  const [rolloverMessage,setRolloverMessage]=useState('')
  const [attemptStarting,setAttemptStarting]=useState(false)
  const [syncStatus,setSyncStatus]=useState<'idle'|'saving'|'synced'|'error'>('idle')
  const [syncMessage,setSyncMessage]=useState('')
  const inFlightSync=useRef(new Set<string>())
  const inFlightAnswers=useRef(new Set<string>())
  const stateRef=useRef(state)
  const activeStorageKey=useRef<string>(guestStorageKey)
  const skipStorageWrite=useRef(false)
  const attemptTokenKey=useRef('')
  const dayTransition=useRef(false)

  useEffect(()=>{userRef.current=user},[user])
  useEffect(()=>{stateRef.current=state},[state])
  useEffect(()=>{
    const activeUser=userRef.current
    const key=activeUser?`${activeUser.id}:${croatiaDateKey()}`:''
    attemptTokenKey.current=key
    attemptToken.current=activeUser?readAttemptToken(activeUser.id,croatiaDateKey()):''
  },[user?.id])
  useEffect(()=>{
    const activeUser=userRef.current
    const storageKey=activeUser?userStorageKey(activeUser.id):guestStorageKey
    if(storageKey===activeStorageKey.current)return
    activeStorageKey.current=storageKey
    skipStorageWrite.current=true
    queueMicrotask(()=>{
      if(activeStorageKey.current===storageKey)setState(loadState(storageKey))
    })
  },[user?.id])

  useEffect(()=>{
    if(skipStorageWrite.current){skipStorageWrite.current=false;return}
    if(!saveState(state,activeStorageKey.current)){
      queueMicrotask(()=>setCloudMessage('Preglednik nije mogao spremiti napredak lokalno. Oslobodi prostor ili koristi račun za sinkronizaciju.'))
    }
  },[state])

  useEffect(()=>{
    const refresh=()=>{if(userRef.current)setConnectionEpoch(epoch=>epoch+1)}
    window.addEventListener('online',refresh)
    window.addEventListener('focus',refresh)
    return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh)}
  },[])

  useEffect(()=>{
    const onStorage=(event:StorageEvent)=>{
      if(event.key!==activeStorageKey.current||!event.newValue)return
      const incoming=loadState(activeStorageKey.current)
      setState(current=>{
        const currentUpdate=Math.max(current.daily.updatedAt,current.timedDaily?.updatedAt??0)
        const incomingUpdate=Math.max(incoming.daily.updatedAt,incoming.timedDaily?.updatedAt??0)
        return incoming.daily.date===current.daily.date&&incomingUpdate>currentUpdate?incoming:current
      })
    }
    window.addEventListener('storage',onStorage)
    return()=>window.removeEventListener('storage',onStorage)
  },[])

  useEffect(()=>{
    if(!supabase)return
    let active=true
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      if(!active)return
      const sessionUser=session?.user??null
      setUser(current=>current?.id===sessionUser?.id?current:sessionUser)
      if(event==='PASSWORD_RECOVERY'){setPasswordRecovery(true);setAuthOpen(true)}
      if(event==='SIGNED_OUT'){attemptToken.current='';attemptTokenKey.current='';setCloudChallenge(null);setCloudGameMode(null);setCloudSnapshot(null);setTimedMode(false);setGuestModeLoading(Boolean(supabase));setCloudStatus('guest');setSyncStatus('idle')}
    })
    void supabase.auth.getSession().then(({data,error})=>{
      if(error)throw error
      if(active){
        const sessionUser=data.session?.user??null
        setUser(current=>current?.id===sessionUser?.id?current:sessionUser)
        if(!sessionUser)setCloudStatus('guest')
      }
    }).catch(error=>{
      if(active){setCloudStatus('error');setCloudMessage(error instanceof Error?error.message:'Prijava se trenutačno ne može provjeriti.')}
    })
    return()=>{active=false;subscription.unsubscribe()}
  },[])

  useEffect(()=>{
    if(!supabase||user?.id){
    queueMicrotask(()=>setGuestModeLoading(false))
    return
    }
    let active=true
    void fetchPublicTimedGameplayEnabled().then(enabled=>{
      if(!active)return
      const guestState=loadState(guestStorageKey)
      const resumedGuestAttempt=guestState.timedDaily?.ruleset==='guest-timed-v1'
        &&guestState.timedDaily.date===croatiaDateKey()
      setTimedMode(enabled||resumedGuestAttempt)
      setCloudStatus('guest')
    }).catch(error=>{
      if(!active)return
      const guestState=loadState(guestStorageKey)
      setTimedMode(guestState.timedDaily?.ruleset==='guest-timed-v1')
      setCloudMessage(error instanceof Error?error.message:'Vremenski način igre nije mogao biti provjeren.')
    }).finally(()=>{if(active)setGuestModeLoading(false)})
    return()=>{active=false}
  },[user?.id,connectionEpoch])

  useEffect(()=>{
    const activeUser=userRef.current
    if(!activeUser||!supabase)return
    let active=true
    const userId=activeUser.id
    const today=croatiaDateKey()
    queueMicrotask(()=>{
      if(!active)return
      setCloudStatus(previous=>previous==='ready'?previous:'loading')
      setCloudMessage('')
      setSyncStatus('idle')
    })
    void (async()=>{
      const [mode,snapshot]=await Promise.all([fetchTodayGameplayMode(today),fetchCloudSnapshot(activeUser)])
      if(!active||userRef.current?.id!==userId||croatiaDateKey()!==today)return
      setCloudGameMode(mode)
      setCloudSnapshot(snapshot)
      const useTimed=mode.attempt_ruleset==='timed-v1'||(mode.timed_enabled&&mode.attempt_ruleset===null)
      if(useTimed){
        setTimedMode(true)
        setCloudChallenge(null)
        if(mode.attempt_ruleset!=='timed-v1'){
          setCloudStatus('ready')
          setState(previous=>{
            const current=previous.daily.date===today?previous.daily:rolloverDaily(previous,today).daily
            return {...previous,daily:current,timedDaily:null}
          })
          return
        }
        if(snapshot.todayResult?.challengeId!==mode.challenge_id){
        const started=await startTimedDailyAttempt(today)
        if(!active||userRef.current?.id!==userId||croatiaDateKey()!==today)return
        attemptToken.current=started.attempt_token
        attemptTokenKey.current=`${userId}:${today}`
        storeAttemptToken(userId,today,started.attempt_token)
        }
        const progressStart=performance.now()
        const rows=await fetchTimedAttemptProgress(today)
        const roundTrip=performance.now()-progressStart
        if(!active||userRef.current?.id!==userId||croatiaDateKey()!==today)return
        const timed=timedDailyFromCloud(today,mode.challenge_id,mode.is_demo,rows,snapshot.todayResult?.challengeId===mode.challenge_id,roundTrip)
        setCloudStatus('ready')
        setState(previous=>{
          const currentDaily=previous.daily.date===today?previous.daily:rolloverDaily(previous,today).daily
          return {...previous,daily:projectTimedProgressToDaily(currentDaily,timed),timedDaily:timed}
        })
        return
      }

      setTimedMode(false)
      const [challenge,progress]=await Promise.all([fetchTodayChallenge(),fetchDailyAttemptProgress(today)])
      if(!active||userRef.current?.id!==userId||croatiaDateKey()!==today)return
      if(getQuestions(challenge.question_ids).length!==5)throw new Error('Dnevni izazov nije usklađen s aplikacijom. Nastavi kao gost dok se pitanje ne uskladi.')
      setCloudChallenge(challenge)
      setCloudStatus('ready')
      const current=stateRef.current
      const hasProgress=current.daily.completed||current.daily.guesses.some(guess=>guess!==null)
      if(!snapshot.todayResult&&current.daily.date===today&&hasProgress&&current.daily.questionIds.join('|')!==challenge.question_ids.join('|')){
        setCloudMessage('Tvoj izazov na ovom uređaju razlikuje se od onoga u računu. Napredak je sačuvan lokalno; današnji rezultat neće se sinkronizirati.')
      }
      setState(previous=>{
        const freshDaily=newDaily(today,challenge.question_ids,challenge.challenge_id)
        if(snapshot.todayResult?.challengeId===challenge.challenge_id){
          const actualPrices=[...freshDaily.actualPrices]
          for(let index=0;index<Math.min(progress?.answered_count??0,5);index++)actualPrices[index]=progress?.actual_prices[index]??actualPrices[index]
          return {...previous,daily:{...freshDaily,actualPrices,index:4,guesses:snapshot.todayResult.guesses,scores:snapshot.todayResult.scores,revealed:false,completed:true},timedDaily:null}
        }
        if(previous.daily.date!==today)return {...previous,daily:freshDaily,timedDaily:null}
        const hasProgress=previous.daily.completed||previous.daily.guesses.some(guess=>guess!==null)
        if(hasProgress&&previous.daily.questionIds.join('|')!==challenge.question_ids.join('|'))return previous
        const localCompleted=previous.daily.completed&&previous.daily.guesses.every(guess=>guess!==null)&&previous.daily.scores.every(score=>score!==null)
        const guesses=Array(5).fill(null) as (number|null)[]
        const scores=Array(5).fill(null) as (number|null)[]
        const actualPrices=[...freshDaily.actualPrices]
        if(hasProgress){
          previous.daily.guesses.forEach((value,index)=>{guesses[index]=value})
          previous.daily.scores.forEach((value,index)=>{scores[index]=value})
          previous.daily.actualPrices.forEach((value,index)=>{actualPrices[index]=value})
        }
        const answeredCount=Math.min(progress?.answered_count??0,5)
        for(let index=0;index<answeredCount;index++){
          guesses[index]=progress?.guesses[index]??null
          scores[index]=progress?.question_scores[index]??null
          actualPrices[index]=progress?.actual_prices[index]??actualPrices[index]
        }
        const index=localCompleted?4:answeredCount>0&&!hasProgress?answeredCount-1
          :answeredCount>0&&previous.daily.index<answeredCount?answeredCount-1
            :previous.daily.index
        const keptRevealed=answeredCount>0&&index===answeredCount-1&&(!hasProgress||previous.daily.index<answeredCount)
        return {...previous,daily:{...freshDaily,...(hasProgress?previous.daily:{}),questionIds:challenge.question_ids,challengeId:challenge.challenge_id,guesses,scores,actualPrices,index,revealed:localCompleted?false:keptRevealed||Boolean(hasProgress&&previous.daily.revealed),completed:localCompleted,updatedAt:Date.now()},timedDaily:null}
      })
    })().catch(error=>{
      if(!active||userRef.current?.id!==userId||croatiaDateKey()!==today)return
      setCloudStatus('error')
      setCloudMessage(error instanceof Error?error.message:'Supabase veza nije dostupna. Možeš nastaviti kao gost.')
    })
    return()=>{active=false}
  },[user?.id,connectionEpoch])

  const getAttemptToken=useCallback(async(date:string,forceRefresh=false)=>{
    if(!user)throw new Error('Prijava je potrebna za sinkronizaciju.')
    const key=`${user.id}:${date}`
    let token=attemptTokenKey.current===key?attemptToken.current:readAttemptToken(user.id,date)
    if(!token||forceRefresh){
      token=await startDailyAttempt(date)
      attemptToken.current=token
      attemptTokenKey.current=key
      if(!storeAttemptToken(user.id,date,token)){
        setCloudMessage('Preglednik ne može spremiti token pokušaja; ostani u ovoj kartici do slanja rezultata.')
      }
    }else if(attemptTokenKey.current!==key){
      attemptToken.current=token
      attemptTokenKey.current=key
    }
    return token
  },[user])

  const syncDailyAnswers=useCallback(async(date:string,daily:DailyProgress,pending?:{index:number;guess:number})=>{
    if(!user||!cloudChallenge||cloudChallenge.challenge_date!==date||cloudChallenge.question_ids.join('|')!==daily.questionIds.join('|')){
      throw new Error('Današnji izazov ne odgovara spremljenom pokušaju.')
    }
    const key=`${user.id}:${date}`
    if(inFlightAnswers.current.has(key))throw new Error('Odgovor se već sinkronizira u ovoj kartici.')
    inFlightAnswers.current.add(key)
    try{
      let token=await getAttemptToken(date)
      let progress=await fetchDailyAttemptProgress(date)
      const guesses=Array(5).fill(null) as (number|null)[]
      const scores=Array(5).fill(null) as (number|null)[]
      const actualPrices=[...daily.actualPrices]
      let answeredCount=Math.min(progress?.answered_count??0,5)
      const retryAnswer=async(position:number,guess:number,refresh=false)=>{
        try{return await submitDailyAnswer(date,position+1,guess,token)}
        catch(error){
          const message=error instanceof Error?error.message:''
          if(!refresh&&message.includes('challenge_attempt_token_expired_or_invalid')){
            token=await getAttemptToken(date,true)
            return retryAnswer(position,guess,true)
          }
          if(message.includes('challenge_answer_already_recorded')){
            progress=await fetchDailyAttemptProgress(date)
            answeredCount=Math.min(progress?.answered_count??0,5)
            const savedGuess=progress?.guesses[position]
            if(savedGuess!==undefined)return submitDailyAnswer(date,position+1,savedGuess,token)
          }
          throw error
        }
      }
      let acceptedCurrent:Awaited<ReturnType<typeof submitDailyAnswer>>|null=null
      for(let index=0;index<5;index++){
        if(index<answeredCount){
          const savedGuess=progress?.guesses[index]
          if(savedGuess===undefined)throw new Error('Poslužitelj je vratio nepotpun napredak.')
          const accepted=await retryAnswer(index,savedGuess)
          guesses[index]=accepted.accepted_guess
          scores[index]=accepted.question_score
          actualPrices[index]=accepted.actual_price
          if(pending?.index===index)acceptedCurrent=accepted
          continue
        }
        const localGuess=pending?.index===index?pending.guess:daily.guesses[index]
        if(localGuess===null||localGuess===undefined)break
        const accepted=await retryAnswer(index,localGuess)
        guesses[index]=accepted.accepted_guess
        scores[index]=accepted.question_score
        actualPrices[index]=accepted.actual_price
        answeredCount=index+1
        if(pending?.index===index)acceptedCurrent=accepted
      }
      return {
        daily:{...daily,guesses,scores,actualPrices,updatedAt:Date.now()},
        acceptedCurrent,
      }
    }finally{
      inFlightAnswers.current.delete(key)
    }
  },[user,cloudChallenge,getAttemptToken])

  const handleAnswer=useCallback(async(date:string,index:number,guess:number,actualPrice:number)=>{
    let daily=stateRef.current.daily
    if(daily.date!==date||daily.index!==index||daily.guesses[index]!==null)throw new Error('Ovaj odgovor više nije aktivan.')
    if(!user||cloudStatus!=='ready'){
      if(user)setCloudMessage('Odgovor je spremljen na ovom uređaju i sinkronizirat će se kada veza bude dostupna.')
      const guesses=[...daily.guesses]
      const scores=[...daily.scores]
      const actualPrices=[...daily.actualPrices]
      guesses[index]=guess
      scores[index]=scoreGuess(guess,actualPrice)
      actualPrices[index]=actualPrice
      return {daily:{...daily,guesses,scores,actualPrices,updatedAt:Date.now()}}
    }
    try{
      const key=`${user.id}:${date}`
      while(inFlightAnswers.current.has(key))await new Promise(resolve=>window.setTimeout(resolve,50))
      daily=stateRef.current.daily
      if(daily.date!==date||daily.index!==index||daily.guesses[index]!==null)throw new Error('Ovaj odgovor više nije aktivan.')
      const result=await syncDailyAnswers(date,daily,{index,guess})
      if(!result.acceptedCurrent)throw new Error('Poslužitelj nije potvrdio odgovor.')
      return {daily:result.daily}
    }catch(error){
      if(!isNetworkFailure(error))throw error
      setCloudMessage('Odgovor je spremljen na ovom uređaju i sinkronizirat će se kada veza bude dostupna.')
      const guesses=[...daily.guesses]
      const scores=[...daily.scores]
      const actualPrices=[...daily.actualPrices]
      guesses[index]=guess
      scores[index]=scoreGuess(guess,actualPrice)
      actualPrices[index]=actualPrice
      return {daily:{...daily,guesses,scores,actualPrices,updatedAt:Date.now()}}
    }
  },[user,cloudStatus,syncDailyAnswers])

  const getTimedAttemptToken=useCallback(async(date:string,forceRefresh=false)=>{
    if(!user)throw new Error('Prijava je potrebna za sinkronizaciju vremenskog pokušaja.')
    const key=`${user.id}:${date}`
    let token=attemptTokenKey.current===key?attemptToken.current:readAttemptToken(user.id,date)
    if(!token||forceRefresh){
      const attempt=await startTimedDailyAttempt(date)
      token=attempt.attempt_token
      attemptToken.current=token
      attemptTokenKey.current=key
      if(!storeAttemptToken(user.id,date,token)){
        setCloudMessage('Preglednik ne može spremiti token pokušaja; ostani u ovoj kartici do slanja rezultata.')
      }
    }else if(attemptTokenKey.current!==key){
      attemptToken.current=token
      attemptTokenKey.current=key
    }
    return token
  },[user])

  const withTimedAttemptToken=useCallback(async <T,>(date:string,operation:(token:string)=>Promise<T>):Promise<T>=>{
    let token=await getTimedAttemptToken(date)
    try{return await operation(token)}
    catch(error){
      if(!getErrorMessage(error).includes('challenge_attempt_token_expired_or_invalid'))throw error
      token=await getTimedAttemptToken(date,true)
      return operation(token)
    }
  },[getTimedAttemptToken])

  const applyTimedProgress=useCallback((progress:TimedDailyProgress)=>{
    setState(previous=>{
      const rolled=previous.daily.date===progress.date?previous:rolloverDaily(previous,progress.date)
      return {...rolled,daily:projectTimedProgressToDaily(rolled.daily,progress),timedDaily:progress}
    })
  },[])

  const timedSyncEpoch=useRef(0)
  const refreshTimedProgress=useCallback(async(date:string,completed=false)=>{
    const activeUser=userRef.current
    if(!activeUser||activeUser.id!==user?.id)throw new Error('Prijava se promijenila; osvježi pokušaj prije nastavka.')
    const mode=cloudGameMode?.challenge_date===date?cloudGameMode:await fetchTodayGameplayMode(date)
    const requestEpoch=++timedSyncEpoch.current
    const requestStarted=performance.now()
    const rows=await fetchTimedAttemptProgress(date)
    const progress=timedDailyFromCloud(date,mode.challenge_id,mode.is_demo,rows,completed,performance.now()-requestStarted)
    if(userRef.current?.id!==activeUser.id||croatiaDateKey()!==date)throw new Error('Dnevni izazov se promijenio; osvježi stranicu za trenutačno stanje.')
    if(requestEpoch!==timedSyncEpoch.current)return stateRef.current.timedDaily??progress
    applyTimedProgress(progress)
    return progress
  },[user,cloudGameMode,applyTimedProgress])

  const handleTimedAnswer=useCallback(async(date:string,position:number,guess:number):Promise<TimedDailyProgress>=>{
    if(userRef.current){
      if(cloudStatus!=='ready')throw new Error('Potrebna je veza sa CIFRA računom za potvrdu odgovora.')
      await withTimedAttemptToken(date,token=>submitTimedAnswer(date,position,guess,token))
      return refreshTimedProgress(date)
    }
    const current=stateRef.current.timedDaily
    if(!current||current.date!==date)throw new Error('Vremenski pokušaj nije dostupan na ovom uređaju.')
    const updated=resolveGuestTimedAnswer(current,position,guess)
    applyTimedProgress(updated)
    return updated
  },[cloudStatus,withTimedAttemptToken,refreshTimedProgress,applyTimedProgress])

  const handleTimedTimeout=useCallback(async(date:string,position:number):Promise<TimedDailyProgress>=>{
    if(userRef.current){
      if(cloudStatus!=='ready')throw new Error('Potrebna je veza sa CIFRA računom za potvrdu isteka vremena.')
      await withTimedAttemptToken(date,token=>expireTimedQuestion(date,position,token))
      return refreshTimedProgress(date)
    }
    const current=stateRef.current.timedDaily
    if(!current||current.date!==date)throw new Error('Vremenski pokušaj nije dostupan na ovom uređaju.')
    const updated=resolveGuestTimedTimeout(current,position)
    applyTimedProgress(updated)
    return updated
  },[cloudStatus,withTimedAttemptToken,refreshTimedProgress,applyTimedProgress])

  const handleTimedNext=useCallback(async(date:string,position:number):Promise<TimedDailyProgress>=>{
    if(userRef.current){
      if(cloudStatus!=='ready')throw new Error('Potrebna je veza sa CIFRA računom za pokretanje sljedećeg pitanja.')
      await withTimedAttemptToken(date,token=>startTimedQuestion(date,position,token))
      return refreshTimedProgress(date)
    }
    const current=stateRef.current.timedDaily
    if(!current||current.date!==date)throw new Error('Vremenski pokušaj nije dostupan na ovom uređaju.')
    const updated=startGuestTimedQuestion(current)
    applyTimedProgress(updated)
    return updated
  },[cloudStatus,withTimedAttemptToken,refreshTimedProgress,applyTimedProgress])

  const finishTimedResult=useCallback(async(date:string,progressOverride?:TimedDailyProgress)=>{
    const current=progressOverride??stateRef.current.timedDaily
    if(!current||current.date!==date||current.questions.length!==5||current.questions.some(question=>question.outcome==='active')){
      throw new Error('Za završetak izazova potrebno je riješiti svih pet pitanja.')
    }
    if(!userRef.current){
      const completed=completeGuestTimedDaily(stateRef.current,current)
      setState(completed)
      return
    }
    if(cloudStatus!=='ready')throw new Error('Potrebna je veza sa CIFRA računom za spremanje rezultata.')
    setSyncStatus('saving')
    setSyncMessage('')
    try{
      await withTimedAttemptToken(date,token=>submitTimedResult(date,token))
      const activeUser=userRef.current
      if(!activeUser)throw new Error('Prijava se promijenila prije spremanja rezultata.')
      const snapshot=await fetchCloudSnapshot(activeUser)
      const completed={...current,completed:true,updatedAt:Date.now()}
      setCloudSnapshot(snapshot)
      setState(previous=>{
        const rolled=previous.daily.date===date?previous:rolloverDaily(previous,date)
        const daily={...projectTimedProgressToDaily(rolled.daily,completed),completed:true,index:4,revealed:false}
        return mergeCloudSnapshot({...rolled,daily,timedDaily:completed},snapshot)
      })
      setSyncStatus('synced')
    }catch(error){
      setSyncStatus('error')
      setSyncMessage(cloudErrorMessage(error,'Rezultat nije potvrđen. Napredak ostaje spremljen; pokušaj ponovno.'))
      throw error
    }
  },[cloudStatus,withTimedAttemptToken])

  const syncCompleted=useCallback(async(completedState:AppState)=>{
    if(!user||completedState.timedDaily?.ruleset==='timed-v1')return
    const date=completedState.daily.date
    const key=`${user.id}:${date}`
    if(inFlightSync.current.has(key))return
    if(cloudSnapshot?.todayResult?.challengeId===cloudChallenge?.challenge_id){
      setSyncStatus('synced')
      return
    }
    if(!cloudChallenge||cloudChallenge.challenge_date!==date||cloudChallenge.question_ids.join('|')!==completedState.daily.questionIds.join('|')){
      setSyncStatus('error')
      setSyncMessage('Današnji izazov na ovom uređaju ne odgovara računu. Napredak je sačuvan lokalno i nije izgubljen.')
      return
    }
    if(completedState.daily.questionIds.length!==5||completedState.daily.guesses.some(guess=>guess===null)){
      setSyncStatus('error')
      setSyncMessage('Današnji izazov nema svih pet procjena i nije moguće sinkronizirati rezultat.')
      return
    }
    if(completedState.daily.guesses.length!==5||completedState.daily.guesses.some(guess=>guess===null)){
      setSyncStatus('error')
      setSyncMessage('Nije moguće sinkronizirati: nedostaje jedna ili više procjena.')
      return
    }
    inFlightSync.current.add(key)
    setSyncStatus('saving')
    setSyncMessage('')
    try{
      while(inFlightAnswers.current.has(key))await new Promise(resolve=>window.setTimeout(resolve,50))
      const {daily:acceptedDaily}=await syncDailyAnswers(date,completedState.daily)
      if(acceptedDaily.guesses.some(guess=>guess===null))throw new Error('Nedostaju poslužiteljski potvrđeni odgovori.')
      let token=await getAttemptToken(date)
      let result
      try{
        result=await submitResult(date,acceptedDaily.guesses as number[],token)
      }catch(error){
        if(!(error instanceof Error)||!error.message.includes('challenge_attempt_token_expired_or_invalid'))throw error
        token=await getAttemptToken(date,true)
        result=await submitResult(date,acceptedDaily.guesses as number[],token)
      }
      setState(previous=>previous.daily.date===date?{...previous,daily:{...previous.daily,...acceptedDaily,scores:result.question_scores,completed:true,revealed:false,index:4,updatedAt:Date.now()}}:previous)
      const snapshot=await fetchCloudSnapshot(user)
      setCloudSnapshot(snapshot)
      if(snapshot.todayResult?.challengeId===cloudChallenge.challenge_id){
        setState(previous=>previous.daily.date===date?{
          ...previous,
          daily:{
            ...previous.daily,
            questionIds:cloudChallenge.question_ids,
            guesses:snapshot.todayResult?.guesses??previous.daily.guesses,
            scores:snapshot.todayResult?.scores??result.question_scores,
            actualPrices:acceptedDaily.actualPrices,
            completed:true,
            revealed:false,
            index:4,
            updatedAt:Date.now(),
          },
        }:previous)
      }
      setCloudMessage('')
      setSyncStatus('synced')
    }catch(error){
      setSyncStatus('error')
      setSyncMessage(cloudErrorMessage(error,'Mrežna pogreška pri spremanju. Rezultat je sačuvan lokalno; pokušaj ponovno.'))
    }finally{
      inFlightSync.current.delete(key)
    }
  },[user,cloudChallenge,cloudSnapshot,syncDailyAnswers,getAttemptToken])

  useEffect(()=>{
    if(userRef.current&&cloudStatus==='ready'&&stateRef.current.daily.completed&&stateRef.current.timedDaily?.ruleset!=='timed-v1'&&syncStatus==='idle')queueMicrotask(()=>void syncCompleted(stateRef.current))
  },[user,cloudStatus,state.daily.completed,state.daily.date,syncStatus,syncCompleted])

  const progressSignature=JSON.stringify([state.daily.guesses,state.daily.scores,state.daily.actualPrices,state.daily.index,state.daily.revealed])
  useEffect(()=>{
    const activeUser=userRef.current
    const daily=stateRef.current.daily
    if(!activeUser||cloudStatus!=='ready'||daily.completed||stateRef.current.timedDaily?.ruleset==='timed-v1'||!daily.guesses.some(guess=>guess!==null))return
    if(cloudChallenge?.challenge_date!==daily.date||cloudChallenge.question_ids.join('|')!==daily.questionIds.join('|'))return
    void syncDailyAnswers(daily.date,daily).then(({daily:syncedDaily})=>{
      setState(previous=>{
        if(previous.daily.date!==syncedDaily.date||previous.daily.questionIds.join('|')!==syncedDaily.questionIds.join('|'))return previous
        const same=JSON.stringify([previous.daily.guesses,previous.daily.scores,previous.daily.actualPrices])===JSON.stringify([syncedDaily.guesses,syncedDaily.scores,syncedDaily.actualPrices])
        return same?previous:{...previous,daily:{...previous.daily,guesses:syncedDaily.guesses,scores:syncedDaily.scores,actualPrices:syncedDaily.actualPrices,updatedAt:Date.now()}}
      })
    }).catch(error=>{
      if(isNetworkFailure(error))setCloudMessage('Nedovršeni odgovori ostaju spremljeni na ovom uređaju i sinkronizirat će se kada veza bude dostupna.')
      else if(!(error instanceof Error&&error.message.includes('već sinkronizira')))setCloudMessage(cloudErrorMessage(error,'Odgovori se još nisu mogli sinkronizirati.'))
    })
  },[user?.id,cloudStatus,progressSignature,cloudChallenge,syncDailyAnswers])

  useEffect(()=>{
    let timer=0
    let active=true
    const advanceDay=async()=>{
      const activeUser=userRef.current
      const today=croatiaDateKey()
      const current=stateRef.current
      if(current.daily.date===today||dayTransition.current)return
      dayTransition.current=true
      setState(previous=>rolloverDaily(previous,today))
      setRolloverMessage('Započeo je novi dnevni izazov. Nedovršeni pokušaj ostao je spremljen na ovom uređaju.')
      if(!activeUser||!supabase){dayTransition.current=false;return}
      setCloudStatus('loading')
      setConnectionEpoch(epoch=>epoch+1)
      dayTransition.current=false
    }
    const schedule=()=>{
      if(!active)return
      timer=window.setTimeout(()=>{
        void advanceDay().finally(schedule)
      },Math.max(1000,millisecondsUntilNextCroatiaDay()+250))
    }
    const recheck=()=>{
      if(document.visibilityState==='visible'&&stateRef.current.daily.date!==croatiaDateKey())void advanceDay()
    }
    schedule()
    document.addEventListener('visibilitychange',recheck)
    window.addEventListener('focus',recheck)
    window.addEventListener('pageshow',recheck)
    return()=>{
      active=false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange',recheck)
      window.removeEventListener('focus',recheck)
      window.removeEventListener('pageshow',recheck)
    }
  },[user?.id])

  const displayState=user&&cloudSnapshot?mergeCloudSnapshot(state,cloudSnapshot):state
  const start=async()=>{
    if(guestModeLoading||attemptStarting)return false
    const today=croatiaDateKey()
    const activeState=state.daily.date===today?state:rolloverDaily(state,today)
    if(activeState!==state)setRolloverMessage('Započeo je novi dnevni izazov. Nedovršeni pokušaj ostao je spremljen na ovom uređaju.')
    if(timedMode){
      const currentTimed=activeState.timedDaily?.date===today?activeState.timedDaily:null
      if(!user){
        if(currentTimed?.ruleset==='guest-timed-v1'){
          const allResolved=currentTimed.questions.length===5&&currentTimed.questions.every(question=>question.outcome!=='active')
          if(allResolved){await finishTimedResult(today,currentTimed);return 'result'}
          return 'game'
        }
        const progress=createGuestTimedDaily(activeState.daily,true)
        setState({...activeState,timedDaily:progress,daily:{...activeState.daily,updatedAt:Date.now()}})
        return 'game'
      }
      if(cloudStatus!=='ready'||!cloudGameMode){
        setCloudMessage('Nije moguće otvoriti vremenski pokušaj bez provjere veze sa CIFRA računom. Pokušaj ponovno kada veza bude dostupna.')
        return false
      }
      setAttemptStarting(true)
      try{
        const started=await startTimedDailyAttempt(today)
        if(userRef.current?.id!==user.id||croatiaDateKey()!==today)return false
        attemptToken.current=started.attempt_token
        attemptTokenKey.current=`${user.id}:${today}`
        storeAttemptToken(user.id,today,started.attempt_token)
        setCloudGameMode({...cloudGameMode,attempt_ruleset:'timed-v1'})
        const progressStart=performance.now()
        const rows=await fetchTimedAttemptProgress(today)
        const timed=timedDailyFromCloud(today,cloudGameMode.challenge_id,cloudGameMode.is_demo,rows,cloudSnapshot?.todayResult?.challengeId===cloudGameMode.challenge_id,performance.now()-progressStart)
        if(userRef.current?.id!==user.id||croatiaDateKey()!==today)return false
        applyTimedProgress(timed)
        const allResolved=timed.questions.length===5&&timed.questions.every(question=>question.outcome!=='active')
        if(allResolved&&!timed.completed){await finishTimedResult(today,timed);return 'result'}
        return timed.completed?'result':'game'
      }catch(error){
        setCloudMessage(cloudErrorMessage(error,'Vremenski pokušaj nije dostupan. Provjeri vezu i pokušaj ponovno.'))
        return false
      }finally{setAttemptStarting(false)}
    }

    if(user&&supabase&&(!cloudGameMode||cloudStatus==='loading')){
      setCloudMessage('Provjeravam način igre prije pokretanja izazova. Pokušaj ponovno za trenutak.')
      return false
    }
    let daily=activeState.daily
    if(user&&cloudChallenge?.challenge_date===today){
      const hasProgress=daily.completed||daily.guesses.some(guess=>guess!==null)
      const matchesChallenge=daily.questionIds.join('|')===cloudChallenge.question_ids.join('|')
      if(hasProgress&&!matchesChallenge){
        setCloudMessage('Napredak na ovom uređaju pripada drugom rasporedu pitanja i ostaje spremljen lokalno. Odjavi se da ga nastaviš; nećemo ga poslati kao današnji računovni rezultat.')
        return false
      }
      if(!hasProgress)daily={...daily,questionIds:cloudChallenge.question_ids,actualPrices:getQuestions(cloudChallenge.question_ids).map(question=>question.actualPrice),challengeId:cloudChallenge.challenge_id}
    }
    if(user){
      setAttemptStarting(true)
      try{
        await getAttemptToken(today)
      }catch(error){
        setCloudStatus('error')
        setCloudMessage(`${cloudErrorMessage(error,'Poslužitelj nije mogao otvoriti pokušaj. Pokušaj ponovno.')} Igra se nastavlja lokalno.`)
        setState({...activeState,daily})
        return 'game'
      }finally{
        setAttemptStarting(false)
      }
    }
    setState({...activeState,daily})
    return 'game'
  }
  const signOut=async()=>{
    if(!supabase)throw new Error('Supabase nije konfiguriran.')
    const {error}=await supabase.auth.signOut()
    if(error)throw error
  }

  return <BrowserRouter><AppShell>
    <Navbar state={displayState} signedIn={Boolean(user)} onHow={()=>setHow(true)} onAccount={()=>setAuthOpen(true)}/>
    <Routes>
      <Route path="/" element={<Home state={state} onStart={start} timedMode={timedMode} isDemo={user?cloudGameMode?.is_demo??cloudChallenge?.is_demo??true:true} challengeLoading={Boolean(attemptStarting||guestModeLoading||user&&cloudStatus==='loading')} cloudNotice={[rolloverMessage,user&&cloudMessage?`${cloudMessage}${cloudStatus==='error'?' Igra ostaje dostupna kao gost.':''}`:!user&&cloudMessage?cloudMessage:''].filter(Boolean).join(' ')}/>}/>
      <Route path="/igra" element={timedMode
        ?<TimedQuestionView state={state} onAnswer={handleTimedAnswer} onTimeout={handleTimedTimeout} onNext={handleTimedNext} onFinish={finishTimedResult} isDemo={user?cloudGameMode?.is_demo??true:true} challengeLoading={Boolean(guestModeLoading||user&&cloudStatus==='loading')}/>
        :<QuestionView state={state} setState={setState} onAnswer={handleAnswer} isDemo={user?cloudChallenge?.is_demo??true:true} challengeLoading={Boolean(user&&cloudStatus==='loading')} onComplete={completed=>{setSyncStatus('idle');if(user)void syncCompleted(completed)}}/>}/>
      <Route path="/rezultat" element={timedMode&&state.timedDaily?.completed
        ?<TimedResults state={displayState} syncStatus={syncStatus} syncMessage={syncMessage} onRetrySync={()=>void finishTimedResult(state.timedDaily?.date??state.daily.date,state.timedDaily??undefined)}/>
        :<Results state={displayState} isDemo={user?cloudGameMode?.is_demo??cloudChallenge?.is_demo??true:true} syncStatus={syncStatus} syncMessage={syncMessage} onRetrySync={()=>void syncCompleted(state)}/>}/>
      <Route path="/statistika" element={<Stats state={displayState}/>}/>
      <Route path="/privatnost" element={<PrivacyPage/>}/>
      <Route path="/uvjeti" element={<TermsPage/>}/>
    </Routes>
    <Footer/>
    <Modal open={how} onClose={()=>setHow(false)}/>
    <AuthDialog open={authOpen} onClose={()=>{setAuthOpen(false);setPasswordRecovery(false)}} signedIn={Boolean(user)} email={user?.email} passwordRecovery={passwordRecovery} onRecoveryComplete={()=>setPasswordRecovery(false)} onSignOut={signOut}/>
  </AppShell></BrowserRouter>
}
