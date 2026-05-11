import React, { useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { ShieldCheck, LogIn, AlertCircle, Mail, Lock, User as UserIcon } from 'lucide-react';
import { loginWithGoogle, loginWithEmail, signupWithEmail } from '../lib/firebase';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from 'sonner';
import BergLogo from '../components/BergLogo';
import { updateProfile } from 'firebase/auth';

export default function LoginView() {
  const [loading, setLoading] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const handleGoogleLogin = async () => {
    setLoading(true);
    setErrorDetails(null);
    try {
      await loginWithGoogle();
      toast.success('Signed in successfully');
    } catch (error: any) {
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorDetails(null);
    try {
      await loginWithEmail(email, password);
      toast.success('Welcome back!');
    } catch (error: any) {
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) {
      toast.error("Please enter your name");
      return;
    }
    setLoading(true);
    setErrorDetails(null);
    try {
      const userCredential = await signupWithEmail(email, password);
      await updateProfile(userCredential.user, { displayName: name });
      toast.success('Account created successfully');
    } catch (error: any) {
      handleAuthError(error);
    } finally {
      setLoading(false);
    }
  };

  const handleAuthError = (error: any) => {
    console.error('Auth Error:', error);
    let message = 'Authentication failed.';
    
    if (error.code === 'auth/popup-blocked') {
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
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-md shadow-2xl border-none overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1.5 bg-blue-600"></div>
        <CardHeader className="text-center pt-10 pb-6">
          <div className="flex justify-center mb-6">
            <div className="bg-white p-6 rounded-3xl shadow-xl shadow-blue-500/10 border border-slate-100 flex flex-col items-center">
              <BergLogo className="h-16 w-48" />
            </div>
          </div>
          <CardTitle className="text-3xl font-black text-slate-900 tracking-tight mt-4">Precision360</CardTitle>
          <CardDescription className="text-slate-500 font-medium">
            Next-generation Quality Management System
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <Tabs defaultValue="login" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-8 h-11 bg-slate-100 p-1 rounded-lg">
              <TabsTrigger value="login" className="rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all">Login</TabsTrigger>
              <TabsTrigger value="signup" className="rounded-md data-[state=active]:bg-white data-[state=active]:shadow-sm transition-all">Sign up</TabsTrigger>
            </TabsList>
            
            <TabsContent value="login" className="space-y-4 outline-none">
              <form onSubmit={handleEmailLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-xs font-bold text-slate-500 uppercase tracking-wider">Email Address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      id="email" 
                      type="email" 
                      placeholder="name@company.com" 
                      className="pl-10 h-12 bg-slate-50/50 border-slate-200 focus:bg-white transition-all w-full"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" colSpan={2} className="text-xs font-bold text-slate-500 uppercase tracking-wider">Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      id="password" 
                      type="password" 
                      placeholder="••••••••" 
                      className="pl-10 h-12 bg-slate-50/50 border-slate-200 focus:bg-white transition-all w-full"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required 
                    />
                  </div>
                </div>
                <Button 
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-lg shadow-blue-600/20 transition-all active:scale-[0.98]"
                >
                  {loading ? <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : "Sign In to Dashboard"}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup" className="space-y-4 outline-none">
              <form onSubmit={handleEmailSignup} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-name" className="text-xs font-bold text-slate-500 uppercase tracking-wider">Full Name</Label>
                  <div className="relative">
                    <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      id="signup-name" 
                      placeholder="John Doe" 
                      className="pl-10 h-12 bg-slate-50/50 border-slate-200 focus:bg-white transition-all w-full"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email" className="text-xs font-bold text-slate-500 uppercase tracking-wider">Email Address</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      id="signup-email" 
                      type="email" 
                      placeholder="name@company.com" 
                      className="pl-10 h-12 bg-slate-50/50 border-slate-200 focus:bg-white transition-all w-full"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password" className="text-xs font-bold text-slate-500 uppercase tracking-wider">Create Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <Input 
                      id="signup-password" 
                      type="password" 
                      placeholder="Min. 6 characters" 
                      className="pl-10 h-12 bg-slate-50/50 border-slate-200 focus:bg-white transition-all w-full"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required 
                    />
                  </div>
                </div>
                <Button 
                  type="submit"
                  disabled={loading}
                  className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-lg shadow-blue-600/20 transition-all active:scale-[0.98]"
                >
                  {loading ? <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : "Create Your Account"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>

          <div className="relative my-8">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-slate-200"></span>
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-4 text-slate-400 font-bold tracking-widest">Or continue with</span>
            </div>
          </div>

          <Button 
            onClick={handleGoogleLogin}
            disabled={loading}
            variant="outline"
            className="w-full h-12 border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-700 font-bold rounded-lg flex items-center justify-center gap-3 transition-all active:scale-[0.98] bg-white shadow-sm"
          >
            {loading ? (
              <div className="h-4 w-4 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
            ) : (
              <>
                <LogIn size={18} className="text-slate-500" />
                Sign in with Google
              </>
            )}
          </Button>

          {errorDetails && (
            <div className="mt-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 text-red-600 text-xs font-medium animate-in fade-in slide-in-from-top-1">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-bold underline">Configuration Error</p>
                <p className="opacity-90 leading-relaxed">{errorDetails}</p>
              </div>
            </div>
          )}
          
          <div className="flex items-center justify-center gap-4 text-[10px] text-slate-400 font-bold uppercase tracking-widest pt-8">
            <span className="h-px w-8 bg-slate-200"></span>
            Enterprise Grade Security
            <span className="h-px w-8 bg-slate-200"></span>
          </div>
        </CardContent>
        <CardFooter className="text-center justify-center border-t border-slate-100 bg-slate-50/50 p-4">
          <p className="text-xs text-slate-500 flex items-center gap-1.5 font-medium">
            <ShieldCheck size={14} className="text-blue-600" /> AES-256 Cloud Protection Enabled
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
