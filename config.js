// Supabase connection. Both values are meant to be public: database rules (supabase/schema.sql)
// make every row readable and writable only by the signed-in person who owns it.
// Clear them to run in phone-only mode (everything saved on this device).
window.YB_CONFIG = {
  supabaseUrl: 'https://fhmgpvfvfhxynbuubfba.supabase.co',
  supabaseAnonKey: 'sb_publishable_ChGZRJtu_B3j-PNbMBtm6w_t4k-xlRJ'
};
