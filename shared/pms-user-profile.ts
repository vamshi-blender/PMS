import { z } from "zod";

const field = z.string().trim().max(500).nullable();
export const pmsUserProfileSchema = z.object({
  firstName: field, lastName: field, email: field, manager: field,
  gender: field, department: field, designation: field,
}).strict();

export type PmsUserProfile = z.infer<typeof pmsUserProfileSchema>;
