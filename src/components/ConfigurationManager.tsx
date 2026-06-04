import React, { useState, useEffect } from 'react';
import { Plus, X, Save, ShieldCheck, TrendingUp, CloudLightning, Database } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Separator } from './ui/separator';
import { toast } from 'sonner';
import { AppConfig } from '../types';
import { MOCK_CONFIG } from '../lib/sample-data';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
export default function ConfigurationManager() {
  const [config, setConfig] = useState<AppConfig>({
    errorTypes: [...MOCK_CONFIG.errorTypes],
    guidelines: [...MOCK_CONFIG.guidelines],
    themes: [...MOCK_CONFIG.themes],
    skipLimit: MOCK_CONFIG.skipLimit,
    minSamplingCount: 1,
    systemOverrideRights: true,
    kpiTargets: {
      utilization: 90,
      attendance: 95,
      qaScore: 98,
      apt: 100
    }
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const docRef = doc(db, 'config', 'master');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          setConfig(docSnap.data() as AppConfig);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, 'config/master');
      } finally {
        setIsLoading(false);
      }
    };
    loadConfig();
  }, []);

  const addItem = (type: 'errorTypes' | 'guidelines' | 'themes') => {
    const label = type === 'errorTypes' ? 'Error Type(s)' : type === 'guidelines' ? 'Guideline(s)' : 'Theme(s)';
    const input = prompt(`Enter new ${label} (separate multiple values with commas for bulk upload):`);
    if (input) {
      const valuesToAdd = input
        .split(',')
        .map(v => v.trim())
        .filter(v => v !== '');

      if (valuesToAdd.length === 0) {
        return;
      }

      const existingSet = new Set(config[type]);
      const added: string[] = [];
      const skipped: string[] = [];

      valuesToAdd.forEach(val => {
        if (existingSet.has(val)) {
          skipped.push(val);
        } else {
          existingSet.add(val);
          added.push(val);
        }
      });

      if (added.length > 0) {
        setConfig({ ...config, [type]: Array.from(existingSet) });
        toast.success(`Successfully added: ${added.join(', ')}`);
      }
      if (skipped.length > 0) {
        toast.error(`Already exists: ${skipped.join(', ')}`);
      }
    }
  };

  const removeItem = (type: 'errorTypes' | 'guidelines' | 'themes', index: number) => {
    const newItems = [...config[type]];
    const removed = newItems.splice(index, 1);
    setConfig({ ...config, [type]: newItems });
    toast.info(`Removed ${removed}`);
  };

  const handleSave = async () => {
    try {
      await setDoc(doc(db, 'config', 'master'), config);
      toast.success('System configuration saved successfully');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'config/master');
    }
  };

  if (isLoading) return <div>Loading config...</div>;

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">System Configuration</h2>
          <p className="text-slate-500">Manage dropdown masters and core sampling rules</p>
        </div>
        <Button onClick={handleSave} className="bg-blue-600 gap-2">
          <Save size={18} /> Save Changes
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Error Types */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase text-slate-500">Error Types</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {config.errorTypes.map((item, i) => (
                <div key={i} className="flex items-center gap-1 bg-slate-100 px-2 py-1 rounded-md text-sm">
                  {item}
                  <button onClick={() => removeItem('errorTypes', i)} className="text-slate-400 hover:text-red-500">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="w-full border-2 border-dashed border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-200" onClick={() => addItem('errorTypes')}>
              <Plus size={16} className="mr-2" /> Add Error Type
            </Button>
          </CardContent>
        </Card>

        {/* Guidelines */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase text-slate-500">Guidelines</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              {config.guidelines.map((item, i) => (
                <div key={i} className="flex items-center justify-between bg-slate-100 px-3 py-2 rounded-md text-sm">
                  <span className="truncate mr-2">{item}</span>
                  <button onClick={() => removeItem('guidelines', i)} className="text-slate-400 hover:text-red-500">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="w-full border-2 border-dashed border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-200" onClick={() => addItem('guidelines')}>
              <Plus size={16} className="mr-2" /> Add Guideline
            </Button>
          </CardContent>
        </Card>

        {/* Themes */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase text-slate-500">Root Themes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              {config.themes.map((item, i) => (
                <div key={i} className="flex items-center justify-between bg-slate-100 px-3 py-2 rounded-md text-sm">
                  <span>{item}</span>
                  <button onClick={() => removeItem('themes', i)} className="text-slate-400 hover:text-red-500">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="w-full border-2 border-dashed border-slate-200 text-slate-400 hover:text-blue-600 hover:border-blue-200" onClick={() => addItem('themes')}>
              <Plus size={16} className="mr-2" /> Add Theme
            </Button>
          </CardContent>
        </Card>

      </div>

    </div>
  );
}
