import { IsOptional, IsString, MaxLength } from 'class-validator';

/** One of these confirms the deletion: the password for password accounts, the email for Google-only ones. */
export class DeleteAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string;
}
