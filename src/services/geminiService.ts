import { GoogleGenAI, Type } from "@google/genai";
import { AuditRecord } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function analyzePrecision(audits: AuditRecord[]) {
  if (audits.length === 0) {
    return ["Start doing tasks to get AI-powered precision tips!", "Consistent audits lead to better insights.", "Good luck on your next case!"];
  }

  // Filter to look at failures or general performance
  const failures = audits.filter(a => a.status === 'Incorrect');
  const summary = audits.map(a => ({
    errorType: a.errorType,
    vertical: a.vertical,
    category: a.categoryGroup,
    qaComment: a.qaComment,
    status: a.status
  })).slice(-10); // Look at last 10 audits

  const prompt = `Analyze the following quality audit records for a generic data specialist and provide 3 actionable, specific tips to improve their precision. 
  
  Recent Audits:
  ${JSON.stringify(summary)}
  
  Format the output as a JSON array of strings. Each tip should be under 20 words. Focus on patterns in the errors or QA comments.`;

  try {
    let text = '';
    const modelsToTry = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-flash-latest"];
    for (const m of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model: m,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        });
        if (response.text) {
          text = response.text;
          break;
        }
      } catch (err: any) {
        console.warn(`Gemini service model ${m} attempt failed:`, err?.message);
      }
    }

    if (text) {
      return JSON.parse(text) as string[];
    }
    return ["Try to slow down on vertical checks.", "Review MPQC guidelines daily.", "Focus on category group definitions."];
  } catch (error) {
    console.error("Gemini Error:", error);
    return ["Audit analysis currently unavailable.", "Keep focused on accuracy.", "Review the official guidelines."];
  }
}
