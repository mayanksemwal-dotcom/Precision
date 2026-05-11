export const calculateQuality = (compErrorCount: number, mpqcErrorCount: number, rows: number): number => {
  if (rows <= 0) return 0;
  const quality = 100 - ((compErrorCount + mpqcErrorCount) / rows) * 100;
  return Math.max(0, parseFloat(quality.toFixed(2)));
};

export const getAuditStatus = (compErrorCount: number, mpqcErrorCount: number): 'Correct' | 'Incorrect' => {
  return (compErrorCount === 0 && mpqcErrorCount === 0) ? 'Correct' : 'Incorrect';
};

export const getTaskUrl = (taskId: string): string => {
  return `https://nemo.flipkart.net/task/${taskId}`;
};

export const generateSampleCount = (totalTasks: number, coveragePercent: number): number => {
  const calculated = Math.ceil((coveragePercent / 100) * totalTasks);
  return Math.max(1, calculated); // Minimum 1 case rule
};

export const getRandomSample = <T>(items: T[], count: number): T[] => {
  const shuffled = [...items].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
};

