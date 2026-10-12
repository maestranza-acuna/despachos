/* Conexión a Supabase. La clave "publishable/anon" es pública por diseño:
   los datos quedan protegidos por el inicio de sesión y las reglas por rol de la base.
   NUNCA poner aquí la clave service_role / secret. */
window.CONFIG = {
  supabaseUrl: "https://diyevlnccglcstyazyrv.supabase.co",
  supabaseKey: "sb_publishable_DajMOd_aVk7fC_dccMIhTA_J1zxLIfq",
  version: "1.0.0-beta"
};
