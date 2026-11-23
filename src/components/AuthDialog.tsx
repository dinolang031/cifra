import { useEffect, useState, type FormEvent } from 'react'
import { supabase, supabaseConfigurationError } from '../lib/supabase'
import './AuthDialog.css'

type AuthMode = 'login' | 'register' | 'recovery' | 'new-password'

const authRedirectUrl = () => new URL('/', window.location.origin).toString()

interface AuthDialogProps {
  open: boolean
  onClose: () => void
  signedIn: boolean
  email?: string
  passwordRecovery: boolean
  onRecoveryComplete: () => void
  onSignOut: () => Promise<void>
}

function messageForError(message: string) {
  if (message.includes('Invalid login credentials')) return 'Email ili lozinka nisu ispravni.'
  if (message.includes('User already registered')) return 'Račun s tom email adresom već postoji.'
  if (message.includes('Password should be')) return 'Lozinka ne ispunjava sigurnosne uvjete.'
  if (message.includes('Email not confirmed')) return 'Prvo potvrdite email adresu putem poveznice koju smo poslali.'
  return `Zahtjev nije uspio: ${message}`
}

export function AuthDialog({ open, onClose, signedIn, email, passwordRecovery, onRecoveryComplete, onSignOut }: AuthDialogProps) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null
  const activeMode: AuthMode = passwordRecovery ? 'new-password' : mode

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setError('')
    try {
      if (!supabase) {
        setError(supabaseConfigurationError ?? 'Supabase nije dostupan.')
        return
      }

      if (activeMode === 'register') {
        const { data, error: requestError } = await supabase.auth.signUp({
          email: address,
          password,
          options: { emailRedirectTo: authRedirectUrl() },
        })
        if (requestError) throw requestError
        setNotice(data.session
          ? 'Račun je izrađen i prijavljeni ste.'
          : 'Račun je izrađen. Provjerite email i potvrdite adresu prije prijave.')
      } else if (activeMode === 'login') {
        const { error: requestError } = await supabase.auth.signInWithPassword({ email: address, password })
        if (requestError) throw requestError
        onClose()
      } else if (activeMode === 'recovery') {
        const { error: requestError } = await supabase.auth.resetPasswordForEmail(address, {
          redirectTo: authRedirectUrl(),
        })
        if (requestError) throw requestError
        setNotice('Ako račun postoji, poslana je poveznica za postavljanje nove lozinke.')
      } else {
        if (password.length < 6) {
          setError('Lozinka mora imati najmanje 6 znakova.')
          return
        }
        const { error: requestError } = await supabase.auth.updateUser({ password })
        if (requestError) throw requestError
        setNotice('Lozinka je promijenjena.')
        onRecoveryComplete()
        setMode('login')
        setPassword('')
      }
    } catch (requestError) {
      setError(messageForError(requestError instanceof Error ? requestError.message : 'Došlo je do mrežne pogreške.'))
    } finally {
      setBusy(false)
    }
  }

  const title = signedIn
    ? 'Tvoj račun'
    : activeMode === 'register' ? 'Izradi račun'
      : activeMode === 'recovery' ? 'Oporavak lozinke'
        : activeMode === 'new-password' ? 'Nova lozinka' : 'Prijava'

  return <div className="modal-backdrop auth-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" onMouseDown={event => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose} aria-label="Zatvori"><span aria-hidden="true">×</span></button>
      <p className="eyebrow">CIFRA račun</p>
      <h2 id="auth-title">{title}</h2>
      {supabaseConfigurationError && <p className="auth-notice" role="status">{supabaseConfigurationError} I dalje možeš igrati kao gost.</p>}
      {signedIn ? <>
        <p className="auth-copy">Prijavljeni ste. Rezultati se sinkroniziraju s vašim računom kada je današnji izazov dostupan u bazi.</p>
        <button className="primary full" disabled={busy} onClick={async () => {
          setBusy(true)
          setError('')
          try { await onSignOut() }
          catch (requestError) { setError(messageForError(requestError instanceof Error ? requestError.message : 'Odjava nije uspjela.')) }
          finally { setBusy(false) }
        }}>
          {busy ? 'Odjava…' : 'Odjavi se'}
        </button>
        {email && <p className="auth-private-email">Prijavljeni račun: {email}</p>}
      </> : <>
        {activeMode === 'new-password' && <p className="auth-copy">Odaberite novu lozinku za svoj račun.</p>}
        {activeMode !== 'new-password' && <div className="auth-tabs">
          <button type="button" className={activeMode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); setNotice('') }}>Prijava</button>
          <button type="button" className={activeMode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setError(''); setNotice('') }}>Registracija</button>
        </div>}
        <form className="auth-form" onSubmit={submit}>
          {activeMode !== 'new-password' && <label>Email adresa<input type="email" autoComplete="email" required value={address} onChange={event => setAddress(event.target.value)} /></label>}
          {activeMode !== 'recovery' && <label>{activeMode === 'new-password' ? 'Nova lozinka' : 'Lozinka'}<input type="password" autoComplete={activeMode === 'register' ? 'new-password' : activeMode === 'new-password' ? 'new-password' : 'current-password'} required minLength={activeMode === 'register' || activeMode === 'new-password' ? 6 : 1} value={password} onChange={event => setPassword(event.target.value)} /></label>}
          <button className="primary full" type="submit" disabled={busy || Boolean(supabaseConfigurationError)}>
            {busy ? 'Molimo pričekaj…' : activeMode === 'register' ? 'Izradi račun' : activeMode === 'recovery' ? 'Pošalji poveznicu' : activeMode === 'new-password' ? 'Spremi novu lozinku' : 'Prijavi se'}
          </button>
        </form>
        {activeMode === 'login' && <button className="text-button" onClick={() => { setMode('recovery'); setError(''); setNotice('') }}>Zaboravljena lozinka?</button>}
        {(activeMode === 'recovery' || activeMode === 'new-password') && <button className="text-button" onClick={() => { onRecoveryComplete(); setMode('login'); setError(''); setNotice('') }}>Natrag na prijavu</button>}
      </>}
      {notice && <p className="auth-notice" role="status">{notice}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p className="auth-privacy">Registracija nije obavezna. Gostima se napredak čuva lokalno na ovom uređaju.</p>
    </section>
  </div>
}
