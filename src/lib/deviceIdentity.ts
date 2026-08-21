export function getOrCreateDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'dev-server';
  }
  let deviceId = localStorage.getItem('plugos_device_id');
  if (!deviceId || !deviceId.trim() || deviceId === 'null' || deviceId === 'undefined') {
    const uuid = typeof crypto !== 'undefined' && crypto.randomUUID 
      ? crypto.randomUUID() 
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (crypto.getRandomValues(new Uint8Array(1))[0] % 16);
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    deviceId = `dev-${uuid}`;
    localStorage.setItem('plugos_device_id', deviceId);
  }
  return deviceId;
}

