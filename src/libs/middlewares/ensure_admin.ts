import { Request, Response, NextFunction, RequestHandler } from "express";

const ADMIN_ROLE_IDS = new Set<number>([8088]);

function hasAdminFromRoles(roles: any): boolean {
  if (!roles) return false;

  // Puede venir como [8088, 1] o como [{id:8088, role:"Super admin"}, ...]
  if (Array.isArray(roles)) {
    return roles.some((r: any) => {
      const id = Number(r?.id ?? r);
      return ADMIN_ROLE_IDS.has(id);
    });
  }

  // O como objeto único { id: 8088, ... } o número suelto
  const one = Number((roles as any)?.id ?? roles);
  return ADMIN_ROLE_IDS.has(one);
}

const EnsureAdmin = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const roles = (req as any).roles;
      const userRole = (req as any).userRole; // puesto por TokenValidation desde DB

      if (hasAdminFromRoles(roles) || ADMIN_ROLE_IDS.has(Number(userRole))) {
        return next();
      }

      return res.status(403).json({
        header: { success: false, authenticated: true },
        messages: ["Access denied, admin role required"],
      });
    } catch (err) {
      return res.status(500).json({
        header: { success: false, authenticated: false },
        messages: ["Internal server error"],
      });
    }
  };
};

export default EnsureAdmin;
