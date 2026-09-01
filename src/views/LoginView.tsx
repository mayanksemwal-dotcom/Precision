import React, { useState, useEffect } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { ShieldCheck, LogIn, AlertCircle, Mail, Lock, User as UserIcon, Eye, EyeOff, Check, X, BadgeCheck } from 'lucide-react';
import { loginWithGoogle, loginWithEmail, signupWithEmail, db, syncUserProfile, auth } from '../lib/firebase';
import { getLiveTimeISO } from '../lib/timeSync';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { toast } from 'sonner';
import BergLogo from '../components/BergLogo';
import { updateProfile, sendEmailVerification, signOut } from 'firebase/auth';
import { setDoc, doc } from 'firebase/firestore';
import { safeStorage } from '../lib/safeStorage';

export default function LoginView() {
  const [loading, setLoading] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Precision360 | Enterprise Login";
    
    // Ensure index, follow meta for public login surface
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) {
      robotsMeta.setAttribute('content', 'index, follow');
    }

    // Dynamic canonical link
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    if (canonicalLink) {
      canonicalLink.setAttribute('href', `${window.location.origin}${window.location.pathname}`);
    }

    // Check if user was just bounced due to administrator login restriction
    const restrictionNotice = safeStorage.get<string>('login_restriction_message');
    if (restrictionNotice) {
      setErrorDetails(restrictionNotice);
      toast.error(restrictionNotice);
      safeStorage.remove('login_restriction_message');
    }
  }, []);
  
  // Login form states
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Register Modal state
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [registerName, setRegisterName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [showRegConfirmPassword, setShowRegConfirmPassword] = useState(false);

  // Real-time password strength state
  const [pwdCriteria, setPwdCriteria] = useState({
    length: false,
    uppercase: false,
    lowercase: false,
    number: false,
    special: false
  });

  // Calculate password strength criteria in real-time
  useEffect(() => {
    setPwdCriteria({
      length: registerPassword.length >= 6,
      uppercase: /[A-Z]/.test(registerPassword),
      lowercase: /[a-z]/.test(registerPassword),
      number: /[0-9]/.test(registerPassword),
      special: /[!@#$%^&*(),.?":{}|<>]/.test(registerPassword)
    });
  }, [registerPassword]);

  const isPasswordStrong = registerPassword.length >= 6;

  // Email format validation
  const validateEmailFormat = (emailStr: string): boolean => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(emailStr);
  };

  // Lockout storage helper functions
  const checkEmailLockout = (emailAddress: string): { locked: boolean; remainingMinutes: number } => {
    const cleanEmail = emailAddress.toLowerCase().trim();
    const lockoutUntilStr = safeStorage.get<string>(`login_lockout_until_${cleanEmail}`);
    if (lockoutUntilStr) {
      const lockoutTime = parseInt(lockoutUntilStr, 10);
      if (Date.now() < lockoutTime) {
        return { locked: true, remainingMinutes: Math.ceil((lockoutTime - Date.now()) / 1000 / 60) };
      } else {
        // Lock has expired, clean up
        safeStorage.remove(`login_lockout_until_${cleanEmail}`);
        safeStorage.remove(`login_failed_attempts_${cleanEmail}`);
      }
    }
    return { locked: false, remainingMinutes: 0 };
  };

  const incrementEmailFailedAttempts = (emailAddress: string) => {
    const cleanEmail = emailAddress.toLowerCase().trim();
    const attemptsStr = safeStorage.get<string>(`login_failed_attempts_${cleanEmail}`) || '0';
    const nextAttempts = parseInt(attemptsStr, 10) + 1;
    safeStorage.set(`login_failed_attempts_${cleanEmail}`, nextAttempts.toString());
    
    if (nextAttempts >= 3) {
      const lockoutDuration = 30 * 60 * 1000; // 30 minutes
      const lockoutUntil = Date.now() + lockoutDuration;
      safeStorage.set(`login_lockout_until_${cleanEmail}`, lockoutUntil.toString());
      return true; // Locked out now
    }
    return false;
  };

  const clearEmailFailedAttempts = (emailAddress: string) => {
    const cleanEmail = emailAddress.toLowerCase().trim();
    safeStorage.remove(`login_failed_attempts_${cleanEmail}`);
    safeStorage.remove(`login_lockout_until_${cleanEmail}`);
  };

  const handleGoogleLogin = async () => {
    console.log('Attempting Google login...');
    setLoading(true);
    setErrorDetails(null);
    setSuccessMessage(null);
    try {
      const result = await loginWithGoogle();
      await syncUserProfile(result.user, 'google');
      console.log('Google login completed successfully.');
      toast.success('Signed in successfully');
    } catch (error: any) {
      console.error('Google login failed:', error);
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.toLowerCase().trim();
    setErrorDetails(null);
    setSuccessMessage(null);

    if (!validateEmailFormat(cleanEmail)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    
    // Check lockout
    const lockout = checkEmailLockout(cleanEmail);
    if (lockout.locked) {
      const errMsg = `Too many failed login attempts. Attempt with Username & Password is restricted for another ${lockout.remainingMinutes} minutes for this user. (No restriction for Gmail option).`;
      setErrorDetails(errMsg);
      toast.error(errMsg);
      return;
    }

    console.log('Attempting email login...');
    setLoading(true);
    try {
      const result = await loginWithEmail(email, password);
      
      clearEmailFailedAttempts(cleanEmail);
      await syncUserProfile(result.user, 'email');
      console.log('Email login completed successfully.');
      toast.success('Welcome back!');
    } catch (error: any) {
      console.error('Email login failed:', error);
      
      if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
        const lockedNow = incrementEmailFailedAttempts(cleanEmail);
        const attemptsStr = safeStorage.get<string>(`login_failed_attempts_${cleanEmail}`) || '1';
        const attempts = parseInt(attemptsStr, 10);
        
        if (lockedNow) {
          const lockedMsg = 'Too many wrong password attempts. Direct login is locked out for 30 minutes.';
          setErrorDetails(lockedMsg);
          error.message = lockedMsg;
        } else {
          const remaining = 3 - attempts;
          const leftMsg = `Incorrect password. You have ${remaining} attempt(s) remaining before being locked out for 30 minutes.`;
          error.message = leftMsg;
        }
      }
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorDetails(null);
    setSuccessMessage(null);

    const cleanEmail = registerEmail.toLowerCase().trim();

    // 1. Validate email format
    if (!validateEmailFormat(cleanEmail)) {
      toast.error("Please enter a valid email format.");
      return;
    }

    // 2. Validate password strength
    if (!isPasswordStrong) {
      toast.error("Password does not meet all secure requirements.");
      return;
    }

    // 3. Confirm password matches
    if (registerPassword !== registerConfirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    if (!registerName.trim()) {
      toast.error("Please enter your full name.");
      return;
    }

    console.log('Attempting email registration...');
    setLoading(true);
    safeStorage.set('is_registering', 'true');
    try {
      // Create user in Firebase Auth using cleanEmail
      const result = await signupWithEmail(cleanEmail, registerPassword);
      
      // Update displayName
      await updateProfile(result.user, { displayName: registerName });
      
      // Send verification email in fully non-blocking background task (do not await)
      sendEmailVerification(result.user).catch((verificationErr) => {
        console.warn('Background verification email failed to send (non-blocking):', verificationErr);
      });
      
      // Store user profile synchronously with Active status
      const userRef = doc(db, 'users', result.user.uid);
      await setDoc(userRef, {
        uid: result.user.uid,
        email: cleanEmail,
        name: registerName,
        fullName: registerName,
        role: (cleanEmail === 'deepa.shukla@bergtechnologies.co.in') ? 'MANAGER' : 'AGENT', // Initial default on registration
        status: 'Active',
        department: 'Operations',
        Manager: '',
        createdAt: getLiveTimeISO(),
        lastLoginAt: getLiveTimeISO(),
        authProvider: 'email',
        isActive: true,
      });

      console.log('Firebase user and firestore entry provisioned with Active status.');

      // Successfully registered and logged in state
      toast.success("Registration complete! Welcome to Precision360.");
      setIsRegisterOpen(false);

      // Clean registration states
      setRegisterName('');
      setRegisterEmail('');
      setRegisterPassword('');
      setRegisterConfirmPassword('');
    } catch (error: any) {
      console.error('Registration failed:', error);
      handleAuthError(error);
    } finally {
      safeStorage.remove('is_registering');
      setLoading(false);
    }
  };

  const handleAuthError = (error: any) => {
    console.error('Auth Error:', error);
    let message = 'Authentication failed.';
    
    if (error.message && (error.message.includes('RESTRICTED_ACCOUNT') || error.message.includes('restricted by an administrator'))) {
      message = error.message.replace('RESTRICTED_ACCOUNT: ', '');
      setErrorDetails(message);
    } else if (error.message && error.message.includes('DEACTIVATED_ACCOUNT')) {
      message = 'Your account has been deactivated. Please contact your administrator.';
      setErrorDetails(message);
    } else if (error.code === 'auth/popup-blocked') {
      message = 'Login popup was blocked. Please enable popups.';
      setErrorDetails('Enable popups in your browser.');
    } else if (error.code === 'auth/unauthorized-domain') {
      message = 'Domain not authorized in Firebase.';
      setErrorDetails(`Add "${window.location.hostname}" to Firebase authorized domains.`);
    } else if (error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
      message = 'Incorrect email address or password. Please verify and try again.';
      setErrorDetails('Incorrect username or password.');
    } else if (error.code === 'auth/user-not-found') {
      message = 'No account found with this email.';
      setErrorDetails('No registered user was found with this email.');
    } else if (error.code === 'auth/email-already-in-use') {
      message = 'This email is already registered.';
      setErrorDetails('This email is already associated with an account.');
    } else if (error.code === 'auth/weak-password') {
      message = 'Password should be at least 6 characters long.';
      setErrorDetails('Password is too weak.');
    } else if (error.code === 'auth/invalid-email') {
      message = 'Invalid email address format.';
      setErrorDetails('Please enter a valid email format.');
    } else {
      let rawMsg = error.message || 'An unexpected error occurred.';
      if (rawMsg.includes('Firebase:')) {
        rawMsg = rawMsg.replace(/Firebase:\s*/, '').replace(/\(auth\/.*\)\.?/, '').trim();
      }
      message = rawMsg;
      setErrorDetails(error.code || 'unknown_error');
    }
    toast.error(message);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f8fafc] via-[#f1f5f9] to-[#e2e8f0] flex flex-col items-center justify-center p-4 font-sans text-slate-800 relative overflow-hidden">
      
      {/* Visual Ambient Orbs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-200/40 rounded-full blur-[120px] pointer-events-none select-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-sky-200/30 rounded-full blur-[120px] pointer-events-none select-none" />

      {/* Main Single Column Container */}
      <div className="w-full max-w-md my-8 relative z-10">
        
        {/* Simplified Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-slate-900 via-indigo-950 to-[#2c3d6c] bg-clip-text text-transparent">
            Precision360
          </h1>
          <p className="text-xs text-indigo-600 font-bold uppercase tracking-widest mt-1">
            Governance & Performance Portal
          </p>
        </div>

        {/* Glossy Modern Login Card */}
        <Card className="w-full bg-white/70 backdrop-blur-2xl border border-slate-200/85 shadow-[0_30px_60px_-15px_rgba(15,23,42,0.12)] rounded-[2.5rem] overflow-hidden text-slate-800">
          <CardHeader className="text-center pt-8 pb-4">
            <div className="flex justify-center mb-4">
              <BergLogo className="h-16 w-auto px-4" showSubtitle={true} />
            </div>
            <CardDescription className="text-slate-500 font-semibold text-xs tracking-wide">
              Secure enterprise gateway path
            </CardDescription>
          </CardHeader>

          <CardContent className="px-8 pb-8 pt-2 space-y-5">
            
            {/* Action Banner: Verification Successful Notice */}
            {successMessage && (
              <div className="p-3.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start gap-3 text-emerald-800 text-xs font-semibold leading-relaxed animate-in fade-in slide-in-from-top-2 duration-300">
                <BadgeCheck size={18} className="text-emerald-600 shrink-0 mt-0.5 animate-bounce" />
                <p>{successMessage}</p>
              </div>
            )}

            {/* ERROR DETAILS */}
            {errorDetails && (
              <div className="p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 text-red-800 text-xs font-semibold leading-relaxed animate-in fade-in duration-300">
                <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                <p>{errorDetails}</p>
              </div>
            )}

            {/* Google Authentication Section */}
            <Button 
              onClick={handleGoogleLogin}
              disabled={loading}
              className="w-full h-11 bg-white hover:bg-slate-50 text-slate-700 font-semibold rounded-xl flex items-center justify-center gap-2.5 transition-all cursor-pointer hover:shadow-md border border-slate-200 text-[11px] uppercase tracking-wider"
            >
              <svg className="h-4.5 w-4.5 shrink-0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335" />
              </svg>
              Continue with Google
            </Button>

          </CardContent>

          <CardFooter className="text-center justify-center bg-slate-50/50 py-4 px-8 border-t border-slate-200/50">
            <p className="text-[10px] text-indigo-600/75 font-bold uppercase tracking-wider flex items-center gap-1.5 select-none">
              <ShieldCheck size={12} className="text-indigo-500" /> 256-Bit Enterprise Secured
            </p>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
