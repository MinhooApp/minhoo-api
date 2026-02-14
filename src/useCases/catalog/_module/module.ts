import fs from "fs";
import path from "path";
import { Request, Response } from "express";
import { formatResponse } from "../../_response/format_response";

const resolveDataPath = (relative: string): string => {
  const roots = [
    path.join(process.cwd(), "src"),
    path.join(process.cwd(), "dist"),
  ];

  for (const root of roots) {
    const candidate = path.join(root, relative);
    if (fs.existsSync(candidate)) return candidate;
  }

  return path.join(process.cwd(), "src", relative);
};

const readJsonFile = (relative: string) => {
  const filePath = resolveDataPath(relative);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
};

export { Request, Response, formatResponse, readJsonFile };
