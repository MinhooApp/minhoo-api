import bcrypt from "bcryptjs";

const generatePassword = (password: string): string => {
  const salt = bcrypt.genSaltSync();
  const hash = bcrypt.hashSync(password, salt);
  return hash;
};

export default generatePassword;
