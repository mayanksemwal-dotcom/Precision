import React, { useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { ShieldCheck, LogIn, AlertCircle, Mail, Lock, User as UserIcon } from 'lucide-react';
import { loginWithGoogle, loginWithEmail, signupWithEmail, db, syncUserProfile } from '../lib/firebase';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from 'sonner';
import BergLogo from '../components/BergLogo';
import { updateProfile } from 'firebase/auth';
import { collection, query, where, getDocs } from 'firebase/firestore';

export default function LoginView() {
  const [loading, setLoading] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleGoogleLogin = async () => {
    console.log('Attempting Google login...');
    setLoading(true);
    setErrorDetails(null);
    try {
      const result = await loginWithGoogle();
      await syncUserProfile(result.user, 'google');
      console.log('Google login completed successfully (popup closed).');
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
    console.log('Attempting email login...');
    setLoading(true);
    setErrorDetails(null);
    try {
      const result = await loginWithEmail(email, password);
      await syncUserProfile(result.user, 'email');
      console.log('Email login completed successfully.');
      toast.success('Welcome back!');
    } catch (error: any) {
      console.error('Email login failed:', error);
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthError = (error: any) => {
    console.error('Auth Error:', error);
    let message = 'Authentication failed.';
    
    if (error.message && error.message.includes('DEACTIVATED_ACCOUNT')) {
      message = 'Your account has been deactivated. Please contact your administrator.';
    } else if (error.code === 'auth/popup-blocked') {
      message = 'Login popup was blocked. Please enable popups.';
      setErrorDetails('Enable popups in your browser.');
    } else if (error.code === 'auth/unauthorized-domain') {
      message = 'Domain not authorized in Firebase.';
      setErrorDetails(`Add "${window.location.hostname}" to Firebase authorized domains.`);
    } else if (error.code === 'auth/wrong-password') {
      message = 'Incorrect password.';
    } else if (error.code === 'auth/user-not-found') {
      message = 'No account found with this email.';
    } else if (error.code === 'auth/email-already-in-use') {
      message = 'This email is already registered.';
    } else if (error.code === 'auth/weak-password') {
      message = 'Password should be at least 6 characters.';
    } else {
      message = error.message || 'An unexpected error occurred.';
      setErrorDetails(error.code || 'unknown_error');
    }
    toast.error(message);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0b132b] via-[#1c2541] to-[#3a506b] flex flex-col items-center justify-center p-4 font-sans text-white">
      <div className="w-full max-w-5xl grid md:grid-cols-2 gap-12 items-center">
        
        {/* Info Section */}
        <div className="space-y-6 hidden md:block">
            <h1 className="text-5xl font-black leading-tight">Precision360</h1>
            <p className="text-xl text-blue-100/90 font-medium leading-relaxed">
                Enterprise Workforce Performance, Quality, Governance & Compliance Platform
            </p>
            <div className="grid grid-cols-2 gap-4 pt-6">
                {['Workforce TMS', 'KPI Scorecards', 'Warning Management', 'PIP Management'].map((feature) => (
                    <div key={feature} className="p-4 bg-white/5 backdrop-blur-md rounded-xl border border-white/10 font-bold text-sm">
                        {feature}
                    </div>
                ))}
            </div>
        </div>

        {/* Login Card */}
        <Card className="w-full max-w-md bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl rounded-3xl overflow-hidden self-center mx-auto text-slate-900">
            <CardHeader className="text-center pt-10 pb-2">
            <div className="flex justify-center mb-4">
                <div className="bg-white p-2.5 rounded-2xl shadow-inner overflow-hidden flex items-center justify-center">
                <BergLogo className="h-14 w-48" showSubtitle={false} />
                </div>
            </div>
            <CardTitle className="text-2xl font-black text-white tracking-tight">Login</CardTitle>
            </CardHeader>

            <CardContent className="px-8 pb-8 pt-4">
            <Button 
                onClick={handleGoogleLogin}
                disabled={loading}
                className="w-full h-12 bg-white hover:bg-slate-50 text-slate-700 font-bold rounded-xl flex items-center justify-center gap-3 transition-all hover:shadow-lg"
            >
                <LogIn size={18} className="text-blue-600" />
                Continue with Google
            </Button>

            <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-white/20"></span>
                </div>
                <div className="relative flex justify-center text-[10px] uppercase font-bold text-white/50">
                <span className="bg-[#1c2541] px-3">Or</span>
                </div>
            </div>

            <form onSubmit={handleEmailLogin} className="space-y-4">
                <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-bold text-slate-200">Email Address</Label>
                <Input 
                    id="email" 
                    type="email" 
                    className="h-11 bg-white/10 border-white/20 text-white rounded-xl placeholder:text-slate-400"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
                </div>
                <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-bold text-slate-200">Password</Label>
                <Input 
                    id="password" 
                    type="password" 
                    className="h-11 bg-white/10 border-white/20 text-white rounded-xl placeholder:text-slate-400"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                />
                </div>
                <Button 
                type="submit"
                disabled={loading}
                className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg mt-2 transition-all active:scale-[0.98]"
                >
                {loading ? "Signing in..." : "Login"}
                </Button>
            </form>

            {errorDetails && (
                <div className="mt-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3 text-red-100 text-xs font-medium">
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <p>{errorDetails}</p>
                </div>
            )}
            </CardContent>

            <CardFooter className="text-center justify-center bg-black/10 p-4">
            <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest flex items-center gap-1.5">
                <ShieldCheck size={12} className="text-blue-400" /> Enterprise Secure
            </p>
            </CardFooter>
        </Card>
      </div>
    </div>
  );
}
