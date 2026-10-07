import type { IPatientProfile } from '../../interfaces/IProfiles';
import type { IAllergy, IMedicalCondition, IMedicalDocument, IMedication } from '../../interfaces/IMedical';

/** Maps patient profiles and medical records to the API shapes in patient.validation.ts. */

/** Whole years, as of today (UTC). */
export const ageFrom = (dateOfBirth: Date, now = new Date()) => {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const birthdayPassed =
    now.getUTCMonth() > dateOfBirth.getUTCMonth() ||
    (now.getUTCMonth() === dateOfBirth.getUTCMonth() && now.getUTCDate() >= dateOfBirth.getUTCDate());
  if (!birthdayPassed) age--;
  return age;
};

export const presentProfile = (p: IPatientProfile) => ({
  id: String(p._id),
  full_name: p.fullName,
  relation: p.relation,
  gender: p.gender,
  date_of_birth: p.dateOfBirth.toISOString().slice(0, 10),
  age: ageFrom(p.dateOfBirth),
  blood_type: p.bloodType,
});

export const presentCondition = (c: IMedicalCondition) => ({
  id: String(c._id),
  name: c.name,
  notes: c.notes,
});

export const presentMedication = (m: IMedication) => ({
  id: String(m._id),
  name: m.name,
  dosage: m.dosage,
  frequency: m.frequency,
  notes: m.notes,
});

export const presentAllergy = (a: IAllergy) => ({ id: String(a._id), name: a.name, severity: a.severity });

export const presentDocument = (d: IMedicalDocument, fileUrl: string) => ({
  id: String(d._id),
  type: d.type,
  title: d.title,
  mime: d.mime,
  file_url: fileUrl,
  uploaded_at: d.createdAt.toISOString(),
});
