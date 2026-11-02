// worker_run_log voor de PostNL-workers: één keer geschreven in plaats van per worker
// (floatops/matransport#562). De wachtdogs in matransport lezen deze tabel; een mislukte write
// is daarom nooit stil (console.error), maar laat de run zelf ook niet vallen.

export async function startRunLog(supabase, { worker, klantId }) {
  try {
    const { data, error } = await supabase.from('worker_run_log')
      .insert({ worker_naam: worker, klant_id: klantId })
      .select('id').single()
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
    return data?.id ?? null
  } catch (error) {
    console.error('startRunLog mislukt (run gaat gewoon door):', error.message)
    return null
  }
}

export async function eindeRunLog(supabase, runLogId, velden) {
  if (!runLogId) return
  try {
    let { error } = await supabase.from('worker_run_log').update({ afgerond_at: new Date().toISOString(), ...velden }).eq('id', runLogId)
    // Omgeving zonder de kolom leeg_onbevestigd (#357 nog niet gepromoveerd): zonder afsluiten
    // in plaats van de run op 'gestart' te laten hangen.
    if (error && /leeg_onbevestigd/.test(error.message ?? '')) {
      const { leeg_onbevestigd, ...rest } = velden
      ;({ error } = await supabase.from('worker_run_log').update({ afgerond_at: new Date().toISOString(), ...rest }).eq('id', runLogId))
    }
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
  } catch (error) {
    console.error('eindeRunLog mislukt:', error.message)
  }
}
