import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { BrowserRouter, Link, Route, Routes, useNavigate } from 'react-router-dom'
import { BarChart3, Check, ChevronRight, Flame, Menu, Share2, Trophy, X } from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { croatiaDateKey, challengeNumber, formatCroatianDate, formatPrice, getQuestions, loadState, parseGuess, saveState, scoreGuess, newDaily, calculateStreak, getActiveStreak, guestStorageKey, userStorageKey, type AppState } from './lib/game'
import { fetchCloudSnapshot, fetchTodayChallenge, mergeCloudSnapshot, startDailyAttempt, submitResult, type CloudChallenge, type CloudSnapshot } from './lib/cloud'
import { supabase } from './lib/supabase'
import { AuthDialog } from './components/AuthDialog'
import './App.css'

const categoryClass=(category:string)=>category.toLowerCase().replaceAll(' ','-').replaceAll('č','c').replaceAll('ć','c').replaceAll('š','s').replaceAll('ž','z')
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
const cloudErrorMessage=(error:unknown,fallback:string)=>{
  const message=error instanceof Error?error.message:fallback
  if(message.includes('challenge_attempt_submitted_too_soon'))return 'Rezultat se može poslati nakon kratkog vremena provedenog u izazovu. Pričekaj nekoliko sekundi i pokušaj ponovno.'
  if(message.includes('challenge_attempt_expired'))return 'Pokušaj je istekao. Vrati se na početnu i ponovno pokreni današnji izazov.'
  if(message.includes('challenge_attempt_already_submitted'))return 'Današnji rezultat je već spremljen.'
  return message
}

function Logo(){return <Link className="logo" to="/" aria-label="CIFRA početna"><span>CIFRA</span><b>HR</b></Link>}
function StreakBadge({count}:{count:number}){return <div className="streak-badge"><Flame size={16} fill="currentColor"/><strong>{count}</strong><span>dana</span></div>}

function Navbar({state,onHow,onAccount,signedIn}:{state:AppState;onHow:()=>void;onAccount:()=>void;signedIn:boolean}){const [open,setOpen]=useState(false);return <><header className="navbar"><div className="nav-inner"><Logo/><nav className={open?'nav-links open':'nav-links'}><Link to="/" onClick={()=>setOpen(false)}>Igra</Link><Link to="/statistika" onClick={()=>setOpen(false)}>Statistika</Link><button onClick={()=>{setOpen(false);onHow()}}>Kako igrati</button></nav><div className="nav-actions"><StreakBadge count={state.currentStreak}/><button className="account-button" onClick={onAccount}>{signedIn?'Moj račun':'Prijava'}</button><button className="menu-button" onClick={()=>setOpen(!open)} aria-label="Izbornik">{open?<X/>:<Menu/>}</button></div></div></header></>}

function Modal({open,onClose}:{open:boolean;onClose:()=>void}){useEffect(()=>{if(!open)return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose()};document.addEventListener('keydown',onKey);document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',onKey);document.body.style.overflow=''}},[open,onClose]);if(!open)return null;return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="how-title" onMouseDown={e=>e.stopPropagation()}><button className="modal-close" onClick={onClose} aria-label="Zatvori"><X/></button><p className="eyebrow">Upute</p><h2 id="how-title">Kako se igra?</h2><ol className="steps"><li><span>01</span><div><strong>5 novih pitanja svaki dan</strong><p>Isti izazov dobiva svaki igrač.</p></div></li><li><span>02</span><div><strong>Procijeni cijenu</strong><p>Upiši iznos u eurima i potvrdi svoju procjenu.</p></div></li><li><span>03</span><div><strong>Što si bliže, više bodova</strong><p>Svako pitanje donosi do 1.000 bodova.</p></div></li><li><span>04</span><div><strong>Ostvari dnevni rezultat</strong><p>Danas možeš osvojiti najviše 5.000 bodova.</p></div></li></ol><button className="primary full" onClick={onClose}>JASNO</button></section></div>}

function Footer(){return <footer><div><Logo/><p>CIFRA — Koliko zapravo košta Hrvatska?</p></div><div className="footer-meta"><p>Svaki dan novi izazov.</p><small>Cijene u igri služe za zabavu i informativnu usporedbu. Mogu se razlikovati ovisno o lokaciji, vremenu i prodavatelju.</small><nav className="footer-links"><Link to="/privatnost">Privatnost</Link><Link to="/uvjeti">Uvjeti</Link></nav></div></footer>}

function Home({state,onStart,cloudNotice,challengeLoading}:{state:AppState;onStart:()=>Promise<boolean>;cloudNotice:string;challengeLoading:boolean}){const navigate=useNavigate();const today=state.daily;const completed=today.completed;const started=today.guesses.some(v=>v!==null);const date=formatCroatianDate(croatiaDateKey());const progress=today.guesses.filter(v=>v!==null).length;return <main className="home"><section className="hero-panel"><div className="hero-copy"><div className="challenge-heading"><p className="eyebrow">DAILY CHALLENGE</p><span>IZAZOV #{challengeNumber(croatiaDateKey()).toString().padStart(3,'0')}</span></div><h1>Koliko dobro<br/><em>poznaješ cijene?</em></h1><p className="hero-lead">Pet pitanja. Jedan dan. Provjeri koliko Hrvatska košta.</p></div><div className="challenge-card"><div className="challenge-top"><div><span className="label">DANAŠNJI IZAZOV <b className="demo-pill">DEMO</b></span><strong>{date}</strong></div><StreakBadge count={state.currentStreak}/></div><div className="challenge-stats"><div><strong>5</strong><span>pitanja</span></div><div><strong>~2</strong><span>minuta</span></div><div><strong>{progress}/5</strong><span>napredak</span></div></div><div className="progress-track"><span style={{width:`${progress*20}%`}}/></div>{cloudNotice&&<p className="cloud-notice" role="status">{cloudNotice}</p>}{completed?<><div className="completed-score"><Trophy/><div><span>DANAŠNJI REZULTAT</span><strong>{today.scores.reduce<number>((a,b)=>a+(b||0),0).toLocaleString('hr-HR')} / 5.000</strong></div></div><button className="primary full" onClick={()=>navigate('/rezultat')}>Pogledaj rezultat <ChevronRight size={18}/></button></>:<button className="primary full" disabled={challengeLoading} onClick={async()=>{if(await onStart())navigate('/igra')}}>{challengeLoading?'Učitavam izazov…':started?'Nastavi izazov':'Započni današnji izazov'} {!challengeLoading&&<ChevronRight size={18}/>}</button>}</div></section><section className="home-bottom"><p>Svaki dan isti izazov za sve igrače</p><div className="question-previews">{['Hrana','Piće','Prijevoz','Stanovanje','Zabava'].map((c,i)=><span key={c}><b>{i+1}</b>{c}</span>)}</div></section></main>}

function QuestionView({state,setState,onComplete,challengeLoading}:{state:AppState;setState:(s:AppState)=>void;onComplete:(s:AppState)=>void;challengeLoading:boolean}){const navigate=useNavigate();const [raw,setRaw]=useState('');const [error,setError]=useState('');const daily=state.daily;const list=getQuestions(daily.questionIds);const question=list[daily.index];useEffect(()=>{if(daily.completed)navigate('/rezultat');else if(!question)navigate('/')},[daily.completed,question,navigate]);if(challengeLoading)return <main className="empty-state"><p className="eyebrow">DANAŠNJI IZAZOV</p><h1>Učitavam izazov…</h1><p>Provjeravam pitanja i spremljeni rezultat.</p></main>;if(daily.completed||!question)return null; const guess=daily.guesses[daily.index]; const score=daily.scores[daily.index];const submit=(e?:FormEvent)=>{e?.preventDefault();if(daily.revealed||daily.guesses[daily.index]!==null||daily.completed)return;const parsed=parseGuess(raw);if(parsed===null){setError('Upiši iznos do 1.000.000.000 € s najviše dvije decimale.');return}setError('');const points=scoreGuess(parsed,question.actualPrice);const guesses=[...daily.guesses];const scores=[...daily.scores];guesses[daily.index]=parsed;scores[daily.index]=points;setState({...state,daily:{...daily,guesses,scores,revealed:true}})}
 const next=()=>{if(daily.completed){navigate('/rezultat');return}if(daily.index===4){let updated={...state};const guesses=daily.guesses,scores=daily.scores;const total=scores.reduce<number>((a,b)=>a+(b||0),0);const exact=scores.filter((_,i)=>guesses[i]===list[i].actualPrice).length;const avgError=guesses.reduce<number>((sum,g,i)=>sum+(g===null?0:Math.abs(g-list[i].actualPrice)/list[i].actualPrice),0)/5*100;const today=croatiaDateKey();const last=state.history[state.history.length-1];const streak=calculateStreak(last?.date??null,today,state.currentStreak);updated.currentStreak=streak;updated.bestStreak=Math.max(updated.bestStreak,streak);updated.totalGames+=1;updated.totalPoints+=total;updated.bestScore=Math.max(updated.bestScore,total);updated.exactGuesses+=exact;if(!state.history.some(h=>h.date===today))updated.history=[...state.history,{date:today,score:total,accuracy:100-Math.min(100,avgError),exact}].slice(-30);updated.daily={...daily,completed:true,revealed:false,index:4};setState(updated);onComplete(updated);navigate('/rezultat')} else {setRaw('');setError('');setState({...state,daily:{...daily,index:daily.index+1,revealed:false}})}}
 const difference=guess===null?0:guess-question.actualPrice
 return <main className="game-layout"><aside className="game-progress"><p>Pitanje</p><strong>{daily.index+1}<span>/5</span></strong><div className="step-list">{[0,1,2,3,4].map(i=><div className={i<daily.index?'step done':i===daily.index?'step active':'step'} key={i}><span>{i<daily.index?<Check size={12}/>:i+1}</span></div>)}</div></aside><section className="question-card"><div className="question-image"><img src={question.image} alt={question.itemName} onError={event=>{event.currentTarget.onerror=null;event.currentTarget.src='/fallback.svg'}}/><span className={`category-badge ${categoryClass(question.category)}`}>{question.category}</span></div><div className="question-content"><p className="eyebrow">{question.location} · {question.unit}</p><h1>{question.question}</h1>{!daily.revealed?<><form onSubmit={submit}><label htmlFor="guess">Unesi svoju procjenu</label><div className="price-input"><span>€</span><input id="guess" inputMode="decimal" value={raw} onChange={e=>{setRaw(e.target.value);setError('')}} placeholder="0,00" autoFocus/><small>EUR</small></div>{error&&<p className="error" role="alert">{error}</p>}<button className="primary full" type="submit">Potvrdi procjenu <ChevronRight size={18}/></button></form><p className="demo-note">Ilustrativni demo podatak — cijena može biti zamijenjena provjerenim izvorom.</p></>:<div className="reveal"><p className="reveal-label">STVARNA CIJENA</p><div className="actual-price">{formatPrice(question.actualPrice)}</div><div className="comparison"><div><span>TVOJA PROCJENA</span><strong>{formatPrice(guess||0)}</strong></div><div className={difference===0?'status exact':difference>0?'status high':'status low'}>{difference===0?'Tvoja procjena je točna':difference>0?`Bio si ${formatPrice(difference)} iznad cijene.`:`Bio si ${formatPrice(Math.abs(difference))} ispod cijene.`}</div></div><div className="score-earned">+{score?.toLocaleString('hr-HR')} <span>BODA</span></div><div className="comparison-bar"><i style={{left:`${Math.min(96,Math.max(4,(Math.min(guess||0,question.actualPrice*2)/(question.actualPrice*2))*100))}%`}}/><b style={{left:`50%`}}/></div><p className="explanation">{question.explanation}</p><button className="primary full" onClick={next}>{daily.index===4?'Pogledaj rezultat':'Sljedeće pitanje'} <ChevronRight size={18}/></button></div>}</div></section></main>
}

function Results({state,syncStatus,syncMessage,onRetrySync}:{state:AppState;syncStatus:'idle'|'saving'|'synced'|'error';syncMessage:string;onRetrySync:()=>void}){const navigate=useNavigate();const [toast,setToast]=useState('');const list=getQuestions(state.daily.questionIds);const total=state.daily.scores.reduce<number>((a,b)=>a+(b||0),0);const exact=state.daily.scores.filter((_,i)=>state.daily.guesses[i]===list[i].actualPrice).length;const avgError=list.reduce((sum,q,i)=>{const g=state.daily.guesses[i];return sum+(g===null?0:Math.abs(g-q.actualPrice)/q.actualPrice)},0)/5*100;const message=total<1500?'Možda je vrijeme za češći odlazak u trgovinu.':total<2500?'Nije loše! Ali cijene su te malo iznenadile.':total<3500?'Dobro poznaješ svakodnevne cijene.':total<4500?'Pravi majstor cijena!':'Ti očito znaš koliko Hrvatska košta.';const boxes=state.daily.scores.map(s=>(s||0)>=850?'🟩':(s||0)>=650?'🟨':(s||0)>=350?'🟧':'⬜').join('');const share=async()=>{const text=`CIFRA #${challengeNumber(state.daily.date).toString().padStart(3,'0')}\n🏆 ${total.toLocaleString('hr-HR')} / 5.000\n${boxes}\nPogodio sam cijene u Hrvatskoj!\n🔥 ${state.currentStreak} dana streak\n\ncifra.hr`;try{if(navigator.share)await navigator.share({title:'CIFRA rezultat',text});else{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}}catch{try{await navigator.clipboard.writeText(text);setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}catch{const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();setToast('Rezultat kopiran!');setTimeout(()=>setToast(''),2600)}}};if(!state.daily.completed)return <main className="empty-state"><BarChart3/><h1>Još nema rezultata</h1><p>Dovrši današnji izazov.</p><button className="primary" onClick={()=>navigate('/')}>Natrag na igru</button></main>;return <main className="results"><section className="result-hero"><p className="eyebrow">DANAŠNJI IZAZOV ZAVRŠEN</p><h1>SVAKA ČAST!</h1><p>{message}</p><div className="result-score"><strong>{total.toLocaleString('hr-HR')}</strong><span>/ 5.000</span></div><div className="score-grid">{state.daily.scores.map((s,i)=><div key={i}><span>{i+1}</span><i style={{height:`${(s||0)/10}%`}}/></div>)}</div><button className="share-button" onClick={share}><Share2 size={18}/> Podijeli rezultat</button>{toast&&<div className="toast">{toast}</div>}{syncStatus==='saving'&&<p className="sync-status" role="status">Spremam rezultat na tvoj CIFRA račun…</p>}{syncStatus==='synced'&&<p className="sync-status" role="status">Rezultat i niz sinkronizirani su s tvojim računom.</p>}{syncStatus==='error'&&<div className="sync-error" role="alert"><p>{syncMessage}</p><button className="text-button" onClick={onRetrySync}>Pokušaj ponovno</button></div>}</section><section className="result-metrics"><div><strong>{Math.round(total/50)}%</strong><span>ostvareno</span></div><div><strong>{exact}</strong><span>točnih pogotka</span></div><div><strong>{avgError.toFixed(0)}%</strong><span>prosječna pogreška</span></div><div><strong>{state.currentStreak}</strong><span>trenutni niz</span></div><div><strong>{state.bestStreak}</strong><span>najbolji niz</span></div></section><section className="result-list"><div className="section-heading"><p className="eyebrow">Pregled odgovora</p><h2>Tvoj dnevni redoslijed</h2></div>{list.map((q,i)=>{const guess=state.daily.guesses[i]||0;const diff=guess-q.actualPrice;return <article className="result-row" key={q.id}><span className="row-index">{i+1}</span><img src={q.image} alt="" onError={event=>{event.currentTarget.onerror=null;event.currentTarget.src='/fallback.svg'}}/><div className="row-main"><span className={`category-badge ${categoryClass(q.category)}`}>{q.category}</span><strong>{q.itemName}</strong></div><div className="row-prices"><span><small>Tvoja procjena</small><b>{formatPrice(guess)}</b></span><span><small>Stvarna cijena</small><b>{formatPrice(q.actualPrice)}</b></span></div><div className={diff===0?'row-diff exact':diff>0?'row-diff high':'row-diff low'}>{diff===0?'Točno':diff>0?`+${formatPrice(diff)}`:`-${formatPrice(Math.abs(diff))}`}</div><strong className="row-score">{(state.daily.scores[i]||0).toLocaleString('hr-HR')} <small>bod.</small></strong></article>})}</section></main>}

function Stats({state}:{state:AppState}){const avg=state.totalGames?Math.round(state.totalPoints/state.totalGames):0;const avgAccuracy=state.history.length?Math.round(state.history.reduce((a,h)=>a+h.accuracy,0)/state.history.length):0;const cards=[['Odigrane igre',state.totalGames],['Trenutni niz',state.currentStreak],['Najbolji niz',state.bestStreak],['Ukupno bodova',state.totalPoints.toLocaleString('hr-HR')],['Prosječan rezultat',avg.toLocaleString('hr-HR')],['Najbolji rezultat',state.bestScore.toLocaleString('hr-HR')],['Prosječna točnost',`${avgAccuracy}%`],['Točni pogoci',state.exactGuesses]];return <main className="stats-page"><div className="stats-heading"><p className="eyebrow">Tvoj napredak</p><h1>Statistika</h1></div>{state.history.length?<><div className="stats-grid">{cards.map(([label,value])=><article className="stat-card" key={label as string}><span>{label}</span><strong>{value}</strong></article>)}</div><section className="chart-card"><div className="section-heading"><div><p className="eyebrow">Posljednjih 30 dana</p><h2>Dnevni rezultati</h2></div><strong>MAX 5.000</strong></div><div className="chart"><div className="chart-lines"><i/><i/><i/><i/></div>{state.history.slice(-10).map(h=><div className="chart-bar-wrap" key={h.date}><div className="chart-bar" style={{height:`${h.score/50}%`}}><span>{h.score}</span></div><small>{h.date.slice(8)}</small></div>)}</div></section></>:<section className="empty-state"><BarChart3/><h1>Statistika se tek počinje pisati.</h1><p>Odigraj svoj prvi izazov i vrati se sutra.</p><Link className="primary" to="/">Započni igru</Link></section>}</main>}

function PrivacyPage(){return <main className="legal-page"><p className="eyebrow">Pravila</p><h1>Privatnost</h1><p>Registracija u CIFRA-i nije obavezna. Gostima se napredak i povijest spremaju lokalno u pregledniku. Ako izradite račun, Supabase obrađuje vašu email adresu, profil, odgovore i rezultate radi prijave i sinkronizacije među uređajima.</p><p>Rezultati računa mogu se čitati samo uz prijavu na pripadajući račun. Lokalni podaci ostaju na uređaju dok se ne očiste podaci preglednika.</p></main>}
function TermsPage(){return <main className="legal-page"><p className="eyebrow">Pravila</p><h1>Uvjeti korištenja</h1><p>Cijene i pitanja u aplikaciji služe za zabavu i informativnu usporedbu. Trenutni skup podataka označen je kao ilustrativni demo i nije potvrđeni skup tržišnih cijena.</p><p>Rezultati prijavljenih korisnika računaju se na poslužitelju iz spremljenih cijena izazova, ali to ne dokazuje da je igrač odgovarao bez pomoći ili automatizacije. Rezultati nisu natjecateljski rang.</p></main>}

export default function App(){
  const [state,setState]=useState<AppState>(()=>loadState())
  const [user,setUser]=useState<User|null>(null)
  const attemptToken=useRef('')
  const [authOpen,setAuthOpen]=useState(false)
  const [passwordRecovery,setPasswordRecovery]=useState(false)
  const [how,setHow]=useState(false)
  const [cloudChallenge,setCloudChallenge]=useState<CloudChallenge|null>(null)
  const [cloudSnapshot,setCloudSnapshot]=useState<CloudSnapshot|null>(null)
  const [cloudStatus,setCloudStatus]=useState<'guest'|'loading'|'ready'|'error'>(supabase?'loading':'guest')
  const [cloudMessage,setCloudMessage]=useState('')
  const [attemptStarting,setAttemptStarting]=useState(false)
  const [syncStatus,setSyncStatus]=useState<'idle'|'saving'|'synced'|'error'>('idle')
  const [syncMessage,setSyncMessage]=useState('')
  const inFlightSync=useRef(new Set<string>())
  const stateRef=useRef(state)
  const activeStorageKey=useRef<string>(guestStorageKey)
  const skipStorageWrite=useRef(false)

  useEffect(()=>{stateRef.current=state},[state])
  useEffect(()=>{
    attemptToken.current=user?readAttemptToken(user.id,croatiaDateKey()):''
  },[user])
  useEffect(()=>{
    const storageKey=user?userStorageKey(user.id):guestStorageKey
    if(storageKey===activeStorageKey.current)return
    activeStorageKey.current=storageKey
    skipStorageWrite.current=true
    queueMicrotask(()=>{
      if(activeStorageKey.current===storageKey)setState(loadState(storageKey))
    })
  },[user])

  useEffect(()=>{
    if(skipStorageWrite.current){skipStorageWrite.current=false;return}
    saveState(state,activeStorageKey.current)
  },[state])

  useEffect(()=>{
    if(!supabase)return
    let active=true
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      if(!active)return
      setUser(session?.user??null)
      if(event==='PASSWORD_RECOVERY'){setPasswordRecovery(true);setAuthOpen(true)}
      if(event==='SIGNED_OUT'){setCloudChallenge(null);setCloudSnapshot(null);setCloudStatus('guest');setSyncStatus('idle')}
    })
    void supabase.auth.getSession().then(({data,error})=>{
      if(error)throw error
      if(active){
        const sessionUser=data.session?.user??null
        setUser(sessionUser)
        if(!sessionUser)setCloudStatus('guest')
      }
    }).catch(error=>{
      if(active){setCloudStatus('error');setCloudMessage(error instanceof Error?error.message:'Prijava se trenutačno ne može provjeriti.')}
    })
    return()=>{active=false;subscription.unsubscribe()}
  },[])

  useEffect(()=>{
    if(!user||!supabase)return
    let active=true
    queueMicrotask(()=>{
      if(!active)return
      setCloudStatus('loading')
      setCloudMessage('')
      setSyncStatus('idle')
    })
    void Promise.all([fetchTodayChallenge(),fetchCloudSnapshot(user)]).then(([challenge,snapshot])=>{
      if(!active)return
      if(getQuestions(challenge.question_ids).length!==5)throw new Error('Dnevni izazov nije usklađen s aplikacijom. Nastavi kao gost dok se pitanje ne uskladi.')
      setCloudChallenge(challenge)
      setCloudSnapshot(snapshot)
      setCloudStatus('ready')
      const current=stateRef.current
      const today=croatiaDateKey()
      const hasProgress=current.daily.completed||current.daily.guesses.some(guess=>guess!==null)
      if(!snapshot.todayResult&&current.daily.date===today&&hasProgress&&current.daily.questionIds.join('|')!==challenge.question_ids.join('|')){
        setCloudMessage('Tvoj izazov na ovom uređaju razlikuje se od onoga u računu. Napredak je sačuvan lokalno; današnji rezultat neće se sinkronizirati.')
      }
      setState(previous=>{
        if(snapshot.todayResult?.challengeId===challenge.challenge_id){
          return {...previous,daily:{date:today,questionIds:challenge.question_ids,index:4,guesses:snapshot.todayResult.guesses,scores:snapshot.todayResult.scores,revealed:false,completed:true}}
        }
        if(previous.daily.date!==today)return {...previous,daily:{...newDaily(today),questionIds:challenge.question_ids}}
        const hasProgress=previous.daily.completed||previous.daily.guesses.some(guess=>guess!==null)
        if(!hasProgress)return {...previous,daily:{...previous.daily,questionIds:challenge.question_ids}}
        return previous
      })
    }).catch(error=>{
      if(!active)return
      setCloudStatus('error')
      setCloudMessage(error instanceof Error?error.message:'Supabase veza nije dostupna. Možeš nastaviti kao gost.')
    })
    return()=>{active=false}
  },[user])

  const syncCompleted=useCallback(async(completedState:AppState)=>{
    if(!user)return
    const date=completedState.daily.date
    const key=`${user.id}:${date}`
    if(inFlightSync.current.has(key))return
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
      let token=attemptToken.current||readAttemptToken(user.id,date)
      if(!token){
        token=await startDailyAttempt(date)
        attemptToken.current=token
        if(!storeAttemptToken(user.id,date,token)){
          setCloudMessage('Preglednik ne može spremiti token pokušaja; ostani u ovoj kartici do slanja rezultata.')
        }
      }
      let result
      try{
        result=await submitResult(date,completedState.daily.guesses as number[],token)
      }catch(error){
        if(!(error instanceof Error)||!error.message.includes('challenge_attempt_token_expired_or_invalid'))throw error
        token=await startDailyAttempt(date)
        attemptToken.current=token
        if(!storeAttemptToken(user.id,date,token)){
          setCloudMessage('Preglednik ne može spremiti token pokušaja; ostani u ovoj kartici do slanja rezultata.')
        }
        result=await submitResult(date,completedState.daily.guesses as number[],token)
      }
      setState(previous=>previous.daily.date===date?{...previous,daily:{...previous.daily,scores:result.question_scores,completed:true,revealed:false,index:4}}:previous)
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
            completed:true,
            revealed:false,
            index:4,
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
  },[user,cloudChallenge])

  useEffect(()=>{
    if(user&&cloudStatus==='ready'&&stateRef.current.daily.completed&&syncStatus==='idle')void syncCompleted(stateRef.current)
  },[user,cloudStatus,state.daily.completed,state.daily.date,syncStatus,syncCompleted])

  useEffect(()=>{
    const timer=window.setInterval(()=>{
      const today=croatiaDateKey()
      setState(previous=>previous.daily.date===today?previous:{
        ...previous,
        daily:newDaily(today),
        currentStreak:getActiveStreak(previous.history.length?previous.history[previous.history.length-1].date:null,today,previous.currentStreak),
      })
      if(user&&supabase){
        setCloudStatus('loading')
        void Promise.all([fetchTodayChallenge(),fetchCloudSnapshot(user)]).then(([challenge,snapshot])=>{
          if(getQuestions(challenge.question_ids).length!==5)throw new Error('Dnevni izazov nije usklađen s aplikacijom.')
          setCloudChallenge(challenge)
          setCloudSnapshot(snapshot)
          setCloudStatus('ready')
          setCloudMessage('')
          setState(previous=>previous.daily.date===today
            ?{...previous,daily:snapshot.todayResult?.challengeId===challenge.challenge_id
              ?{date:today,questionIds:challenge.question_ids,index:4,guesses:snapshot.todayResult.guesses,scores:snapshot.todayResult.scores,revealed:false,completed:true}
              :{...newDaily(today),questionIds:challenge.question_ids}}
            :previous)
        }).catch(error=>{
          setCloudStatus('error')
          setCloudMessage(error instanceof Error?error.message:'Novi izazov nije dostupan; možeš nastaviti kao gost.')
        })
      }
    },60000)
    return()=>window.clearInterval(timer)
  },[user])

  const displayState=user&&cloudSnapshot?mergeCloudSnapshot(state,cloudSnapshot):state
  const start=async()=>{
    const today=croatiaDateKey()
    let daily=today===state.daily.date?state.daily:newDaily(today)
    if(user&&cloudChallenge?.challenge_date===today){
      const hasProgress=daily.completed||daily.guesses.some(guess=>guess!==null)
      const matchesChallenge=daily.questionIds.join('|')===cloudChallenge.question_ids.join('|')
      if(hasProgress&&!matchesChallenge){
        setCloudMessage('Napredak na ovom uređaju pripada drugom rasporedu pitanja i ostaje spremljen lokalno. Odjavi se da ga nastaviš; nećemo ga poslati kao današnji računovni rezultat.')
        return false
      }
      if(!hasProgress)daily={...daily,questionIds:cloudChallenge.question_ids}
    }
    if(user){
      setAttemptStarting(true)
      try{
        let token=attemptToken.current||readAttemptToken(user.id,today)
        if(!token){
          token=await startDailyAttempt(today)
          attemptToken.current=token
          if(!storeAttemptToken(user.id,today,token)){
            setCloudMessage('Preglednik ne može spremiti token pokušaja; ostani u ovoj kartici do slanja rezultata.')
          }
        }
      }catch(error){
        setCloudStatus('error')
        setCloudMessage(`${cloudErrorMessage(error,'Poslužitelj nije mogao otvoriti pokušaj. Pokušaj ponovno.')} Igra se nastavlja lokalno.`)
        setState({...state,daily})
        return true
      }finally{
        setAttemptStarting(false)
      }
    }
    setState({...state,daily})
    return true
  }
  const signOut=async()=>{
    if(!supabase)throw new Error('Supabase nije konfiguriran.')
    const {error}=await supabase.auth.signOut()
    if(error)throw error
  }

  return <BrowserRouter>
    <Navbar state={displayState} signedIn={Boolean(user)} onHow={()=>setHow(true)} onAccount={()=>setAuthOpen(true)}/>
    <Routes>
      <Route path="/" element={<Home state={state} onStart={start} challengeLoading={Boolean(attemptStarting||user&&cloudStatus==='loading')} cloudNotice={user&&cloudMessage?`${cloudMessage}${cloudStatus==='error'?' Igra ostaje dostupna kao gost.':''}`:''}/>}/>
      <Route path="/igra" element={<QuestionView state={state} setState={setState} challengeLoading={Boolean(user&&cloudStatus==='loading')} onComplete={completed=>{setSyncStatus('idle');if(user)void syncCompleted(completed)}}/>}/>
      <Route path="/rezultat" element={<Results state={displayState} syncStatus={syncStatus} syncMessage={syncMessage} onRetrySync={()=>void syncCompleted(state)}/>}/>
      <Route path="/statistika" element={<Stats state={displayState}/>}/>
      <Route path="/privatnost" element={<PrivacyPage/>}/>
      <Route path="/uvjeti" element={<TermsPage/>}/>
    </Routes>
    <Footer/>
    <Modal open={how} onClose={()=>setHow(false)}/>
    <AuthDialog open={authOpen} onClose={()=>{setAuthOpen(false);setPasswordRecovery(false)}} signedIn={Boolean(user)} email={user?.email} passwordRecovery={passwordRecovery} onRecoveryComplete={()=>setPasswordRecovery(false)} onSignOut={signOut}/>
  </BrowserRouter>
}
