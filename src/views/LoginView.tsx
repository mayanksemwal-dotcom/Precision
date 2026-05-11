import React, { useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card';
import { ShieldCheck, LogIn } from 'lucide-react';
import { loginWithGoogle } from '../lib/firebase';
import { toast } from 'sonner';

export default function LoginView() {
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    try {
      await loginWithGoogle();
      toast.success('Signed in successfully');
    } catch (error) {
      console.error(error);
      toast.error('Failed to sign in. Please check your internet connection.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4 font-sans">
      <Card className="w-full max-w-md shadow-2xl border-none overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1.5 bg-blue-600"></div>
        <CardHeader className="text-center pt-10 pb-6">
          <div className="flex justify-center mb-8">
            <div className="bg-white p-4 rounded-3xl shadow-md border border-slate-200/50">
              <img 
                src="/berg_logo.png" 
                alt="Berg Technologies" 
                className="h-16 object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
          </div>
          <CardTitle className="text-3xl font-black text-slate-900 tracking-tight">Precision360</CardTitle>
          <CardDescription className="text-slate-500 font-medium">
            Next-generation Quality Management System
          </CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8 space-y-6">
          <div className="bg-slate-50 rounded-xl p-6 border border-slate-100">
             <p className="text-center text-sm text-slate-600 mb-6 font-medium">
               Sign in with your company account to access the audit dashboard.
             </p>
             <Button 
                onClick={handleLogin}
                disabled={loading}
                className="w-full h-12 bg-[#0F172A] hover:bg-slate-900 text-white font-bold rounded-lg shadow-lg flex items-center justify-center gap-3 transition-all active:scale-[0.98]"
             >
               {loading ? (
                 <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
               ) : (
                 <>
                   <LogIn size={20} />
                   Continue with Google
                 </>
               )}
             </Button>
          </div>
          
          <div className="flex items-center justify-center gap-4 text-[10px] text-slate-400 font-bold uppercase tracking-widest">
            <span className="h-px w-8 bg-slate-200"></span>
            Enterprise Security
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
