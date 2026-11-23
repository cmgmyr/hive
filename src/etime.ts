export function parseEtimeSeconds(value: string): number | null {
  const dayForm = /^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/.exec(value);
  const digitForm = /^(\d+)$/.exec(value);
  const fields = dayForm ? dayForm.slice(1).map(Number) : value.split(":").map(Number);
  if (
    !dayForm &&
    !digitForm &&
    ((fields.length === 2 && !/^\d+:\d+$/.test(value)) ||
      (fields.length === 3 && !/^\d+:\d+:\d+$/.test(value)) ||
      (fields.length !== 2 && fields.length !== 3))
  ) {
    return null;
  }
  if (fields.some((field) => !Number.isSafeInteger(field) || field < 0)) return null;

  let total: number;
  if (digitForm) {
    total = fields[0]!;
  } else if (dayForm) {
    const [days, hours, minutes, seconds] = fields;
    if (hours! > 23 || minutes! > 59 || seconds! > 59) return null;
    total = ((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!;
  } else if (fields.length === 2) {
    const [minutes, seconds] = fields;
    if (seconds! > 59) return null;
    total = minutes! * 60 + seconds!;
  } else {
    const [hours, minutes, seconds] = fields;
    if (minutes! > 59 || seconds! > 59) return null;
    total = (hours! * 60 + minutes!) * 60 + seconds!;
  }

  return Number.isSafeInteger(total) ? total : null;
}
