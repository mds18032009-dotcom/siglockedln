renderSearch = async function () {
  $('#pageContent').innerHTML = heading(
    'JELAJAHI SEKOLAH',
    'Cari warga sekolah',
    'Cari akun aktif berdasarkan nama, kelas, atau bidang tugas.'
  ) + `<div class="search-row"><input id="peopleSearch" class="search-field" value="${esc(searchQuery)}" placeholder="Cari nama, kelas, atau bidang..."><button class="btn btn-outline" id="searchReset">Reset</button></div><div class="filter-row">${['Semua','Siswa','Guru','Staf'].map(role => `<button class="filter-chip ${searchRole === role ? 'active' : ''}" data-db-role="${role}">${role}</button>`).join('')}</div><div class="card-title"><h3>Hasil pencarian</h3><small id="searchCount">Memuat akun...</small></div><div class="people-grid" id="peopleResults"></div>`;

  const loadPeople = async () => {
    const query = $('#peopleSearch').value.trim();
    searchQuery = query;
    if (query.length === 1) {
      $('#searchCount').textContent = 'Masukkan minimal 2 karakter';
      $('#peopleResults').innerHTML = '';
      return;
    }

    try {
      const role = searchRole === 'Semua' ? '' : searchRole.toUpperCase();
      const result = await api(`/api/search?q=${encodeURIComponent(query)}&role=${encodeURIComponent(role)}`);
      $('#searchCount').textContent = `${result.people.length} warga sekolah`;
      $('#peopleResults').innerHTML = result.people.map(person => `<article class="person-card"><div class="person-avatar">◌</div><span class="role-tag">${esc(person.role)}</span><h3>${esc(person.name)}</h3><p>${esc(person.detail || '')}</p><button class="btn btn-outline" data-db-person="${esc(person.id)}">Lihat profil</button></article>`).join('') || '<div class="empty-state" style="grid-column:1/-1"><b>Tidak ada akun aktif yang cocok.</b></div>';
      $$('[data-db-person]').forEach(button => button.onclick = async () => {
        try {
          const profile = await api(`/api/search/${encodeURIComponent(button.dataset.dbPerson)}/profile`);
          const person = profile.person;
          const roleName = { SISWA: 'Siswa', GURU: 'Guru', STAF: 'Staf', ADMIN: 'Admin' }[person.role] || person.role;
          const canSeeMetrics = profile.canSeeAcademicMetrics;
          const isStudent = person.role === 'SISWA';
          const average = !isStudent || !canSeeMetrics ? '—' : profile.averageScore === null ? 'Belum ada' : profile.averageScore;
          const rank = !isStudent || !canSeeMetrics ? '—' : profile.rank === null ? 'Belum ada' : `#${profile.rank}`;
          const attendance = canSeeMetrics ? profile.approvedAttendance : '—';
          const attendanceLabel = canSeeMetrics ? 'Absen disetujui' : 'Kehadiran privat';
          $('#pageContent').innerHTML = heading('PROFIL WARGA SEKOLAH', esc(person.name), 'Informasi profil dari database sekolah.') + `<section class="card person-detail"><div class="person-avatar">◌</div><span class="role-tag">${esc(roleName.toUpperCase())}</span><h2>${esc(person.name)}</h2><p class="person-detail-field">${esc(person.detail || 'Kelas atau bidang belum diisi')}</p><p class="profile-bio">${esc(person.bio || 'Bio belum diisi.')}</p><div class="metric-row"><div class="metric"><b>${esc(average)}</b><small>Rata-rata nilai</small></div><div class="metric"><b>${esc(rank)}</b><small>Peringkat kelas</small></div><div class="metric"><b>${esc(attendance)}</b><small>${attendanceLabel}</small></div></div><p class="hint">Nilai dan peringkat hanya dapat dilihat sendiri, admin, atau guru yang membuat tugas untuk kelas siswa tersebut.</p><button class="btn btn-outline" id="backToSearch">Kembali ke hasil pencarian</button></section>`;
          $('#backToSearch').onclick = () => renderSearch();
        } catch (error) {
          toast(error.message);
        }
      });
    } catch (error) {
      $('#searchCount').textContent = error.message;
      $('#peopleResults').innerHTML = '';
    }
  };

  let searchTimer;
  $('#peopleSearch').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadPeople, 250);
  };
  $('#searchReset').onclick = () => {
    searchRole = 'Semua';
    $('#peopleSearch').value = '';
    $$('[data-db-role]').forEach(button => button.classList.toggle('active', button.dataset.dbRole === 'Semua'));
    loadPeople();
  };
  $$('[data-db-role]').forEach(button => button.onclick = () => {
    searchRole = button.dataset.dbRole;
    $$('[data-db-role]').forEach(item => item.classList.toggle('active', item === button));
    loadPeople();
  });

  await loadPeople();
};