export const formatElapsedTime = (totalSeconds: number): string => {
  if (isNaN(totalSeconds) || totalSeconds < 0) return "00:00:00.000";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const milliseconds = Math.floor((totalSeconds % 1) * 1000);

  const pad = (num: number, size: number = 2) => num.toString().padStart(size, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
};
