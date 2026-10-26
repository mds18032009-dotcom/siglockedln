renderProfile = async function () {
  let result;
  try {
    result = await api('/api/profile/me');
  } catch (error) {
    $('#pageContent').innerHTML = heading('AKUN SAYA', 'Profil pribadi', error.message);
    return;
  }

  const profile = result.user;
  const roleLabel = { siswa: 'Siswa', guru: 'Guru', staf: 'Staf', admin: 'Admin' }[profile.role] || profile.role;
  $('#pageContent').innerHTML = heading('AKUN SAYA', 'Profil pribadi', 'Informasi akun aktif yang tersimpan di database sekolah.') + `<div class="grid two-col"><section><div class="profile-cover"></div><div class="profile-info"><div class="profile-avatar">◌</div><h2>${esc(profile.name)}</h2><span class="role-tag">${esc(roleLabel.toUpperCase())}</span><p>${esc(profile.detail || 'Belum ada kelas atau bidang tugas')}</p><div class="profile-bio" id="bioDisplay">${esc(profile.bio || 'Bio belum diisi.')}</div><div class="metric-row"><div class="metric"><b>${result.assignmentCount}</b><small>Tugas tersedia</small></div><div class="metric"><b>${result.approvedAttendance}</b><small>Absen disetujui</small></div><div class="metric"><b>—</b><small>Nilai / peringkat belum tersedia</small></div></div></div></section><section class="card"><div class="card-title"><h3>Ubah bio</h3><small>TERSIMPAN DI DATABASE</small></div><form id="profileBioForm"><textarea id="profileBioInput" class="field" maxlength="300" rows="4" placeholder="Tulis bio singkat...">${esc(profile.bio || '')}</textarea><p id="profileBioError" class="error hidden"></p><button class="btn btn-primary" type="submit">Simpan bio</button></form><div class="side-note" style="margin-top:18px"><h4>Privasi akun</h4><p>Data dasar berasal dari akun aktif Anda. Nilai dan peringkat belum tersedia sampai modul penilaian selesai dihubungkan.</p></div></section></div>`;
  $('#profileBioForm').onsubmit = async event => {
    event.preventDefault();
    try {
      const saved = await api('/api/profile/me', { method: 'PUT', body: JSON.stringify({ bio: $('#profileBioInput').value }) });
      profile.bio = saved.bio;
      $('#bioDisplay').textContent = saved.bio || 'Bio belum diisi.';
      toast('Bio tersimpan di database.');
    } catch (error) {
      $('#profileBioError').textContent = error.message;
      $('#profileBioError').classList.remove('hidden');
    }
  };
};