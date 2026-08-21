import React, { useState } from 'react';
import { StaffMember, UserRole, Branch } from '../types';
import { setStaffPin } from '../lib/security';
import { 
  Users, 
  UserPlus, 
  Key, 
  Shield, 
  UserCheck, 
  UserX, 
  Edit, 
  CheckCircle2, 
  Search, 
  Building2,
  Lock,
  X,
  Trash2
} from 'lucide-react';

interface StaffManagementProps {
  staffList: StaffMember[];
  onUpdateStaff: (updated: StaffMember[]) => void;
  kernel: any;
  branches?: Branch[];
  businessId?: string;
}

export const StaffManagement: React.FC<StaffManagementProps> = ({
  staffList,
  onUpdateStaff,
  kernel,
  branches = [],
  businessId
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  
  // Form State
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('CASHIER');
  const [branchId, setBranchId] = useState(branches[0]?.id || '');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [notification, setNotification] = useState<string | null>(null);

  const filteredStaff = staffList.filter(s => {
    const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesRole = roleFilter === 'ALL' || s.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const handleOpenAddModal = () => {
    setEditingStaff(null);
    setName('');
    setEmail('');
    setPassword('');
    setRole('CASHIER');
    setBranchId(branches[0]?.id || '');
    setPin('');
    setConfirmPin('');
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (staff: StaffMember) => {
    setEditingStaff(staff);
    setName(staff.name);
    setEmail(staff.email || '');
    setPassword('');
    setRole(staff.role);
    setBranchId(staff.branchId);
    setPin('');
    setConfirmPin('');
    setIsModalOpen(true);
  };

  const handleSaveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || (!editingStaff && (!email || !password))) {
      alert('Please provide name, email, and password for new staff.');
      return;
    }

    if (!/^\d{4,8}$/.test(pin)) {
      alert('Employee PIN must be between 4 and 8 numeric digits.');
      return;
    }

    if (pin !== confirmPin) {
      alert('Employee PINs do not match. Please verify.');
      return;
    }

    if (editingStaff) {
      // Edit existing
      const updated = staffList.map(s => s.id === editingStaff.id ? {
        ...s,
        name,
        email,
        role,
        branchId
      } : s);
      onUpdateStaff(updated);

      if (pin) {
        await setStaffPin(editingStaff.id, businessId || '', branchId, pin);
      }

      kernel?.events?.publish?.('STAFF_UPDATED', {
        staffId: editingStaff.id,
        name,
        email,
        role,
        branchId,
        timestamp: new Date().toISOString()
      });

      setNotification(`Updated staff details for "${name}"`);
    } else {
      // Create new via Supabase Auth
      try {
        const { supabase } = await import('../lib/supabase');
        // Register user in Supabase
        const { data, error } = await supabase.auth.signUp({
          email,
          password
        });
        
        if (error) {
          alert('Failed to create staff account: ' + error.message);
          return;
        }

        const newStaffId = data.user?.id || `usr-${Date.now()}`;
        
        const newStaff: StaffMember = {
          id: newStaffId,
          name,
          email,
          role,
          branchId,
          activeShift: false,
          performanceScore: 100
        };
        onUpdateStaff([...staffList, newStaff]);
        
        // Also add to Supabase staff_members table if it exists
        try {
          await supabase.from('staff_members').insert([{
            id: newStaffId,
            business_id: businessId,
            branch_id: branchId,
            name,
            role
          }]);
          if (pin) {
            await setStaffPin(newStaffId, businessId || '', branchId, pin);
          }
        } catch (err) {
          console.error("Could not insert into supabase staff_members table", err);
        }

        kernel?.events?.publish?.('STAFF_CREATED', {
          staffId: newStaffId,
          name,
          email,
          role,
          branchId,
          timestamp: new Date().toISOString()
        });

        setNotification(`Created account for ${name} (${email})`);
        
      } catch (err: any) {
        alert('Error creating user: ' + err.message);
        return;
      }
    }

    setIsModalOpen(false);
    setTimeout(() => setNotification(null), 3500);
  };

  const handleResetPin = async (staff: StaffMember) => {
    const newPin = Math.floor(1000 + Math.random() * 9000).toString();
    await setStaffPin(staff.id, businessId || '', staff.branchId, newPin);

    kernel?.events?.publish?.('STAFF_PIN_RESET', {
      staffId: staff.id,
      name: staff.name,
      timestamp: new Date().toISOString()
    });

    setNotification(`Reset PIN for ${staff.name} to temporary PIN: ${newPin}`);
    setTimeout(() => setNotification(null), 5000);
  };

  const handleToggleSuspend = (staff: StaffMember) => {
    const newScore = staff.performanceScore === 0 ? 95 : 0;
    const updated = staffList.map(s => s.id === staff.id ? { ...s, performanceScore: newScore } : s);
    onUpdateStaff(updated);

    const action = newScore === 0 ? 'STAFF_SUSPENDED' : 'STAFF_REACTIVATED';
    kernel?.events?.publish?.(action, {
      staffId: staff.id,
      name: staff.name,
      timestamp: new Date().toISOString()
    });

    setNotification(`${staff.name} has been ${newScore === 0 ? 'suspended' : 'reactivated'}`);
    setTimeout(() => setNotification(null), 3500);
  };

  const handleDeleteStaff = (staff: StaffMember) => {
    if (confirm(`Are you sure you want to permanently delete ${staff.name}?`)) {
      const updated = staffList.filter(s => s.id !== staff.id);
      onUpdateStaff(updated);

      kernel?.events?.publish?.('STAFF_DELETED', {
        staffId: staff.id,
        name: staff.name,
        timestamp: new Date().toISOString()
      });

      setNotification(`Deleted ${staff.name}`);
      setTimeout(() => setNotification(null), 3500);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-5 text-slate-100">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-xl">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              Staff & Employee Directory ({staffList.length})
            </h2>
            <p className="text-xs text-slate-400">
              Manage operational roles, PIN authorizations, branch transfers & shifts
            </p>
          </div>
        </div>

        <button
          onClick={handleOpenAddModal}
          className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-xl flex items-center gap-2 transition shadow-lg"
        >
          <UserPlus className="w-4 h-4" /> Add Employee
        </button>
      </div>

      {/* Notification Banner */}
      {notification && (
        <div className="p-3 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded-xl flex items-center gap-2 text-xs font-semibold animate-fade-in">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          {notification}
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search employees by name..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
          />
        </div>

        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="w-full sm:w-auto bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-500"
        >
          <option value="ALL">All Roles</option>
          <option value="CASHIER">Cashier</option>
          <option value="KITCHEN_STAFF">Kitchen Staff / Chef</option>
          <option value="MANAGER">Manager</option>
          <option value="OWNER">Owner</option>
          <option value="ADMINISTRATOR">Administrator</option>
        </select>
      </div>

      {/* Staff Directory Display: Responsive Table & Mobile Cards */}
      {/* Desktop & Tablet Table (Hidden on small screens) */}
      <div className="hidden md:block overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-900 border-b border-slate-800 text-slate-400 font-semibold">
            <tr>
              <th className="p-3">Employee</th>
              <th className="p-3">Role</th>
              <th className="p-3">Branch</th>
              <th className="p-3">PIN</th>
              <th className="p-3">Shift Status</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filteredStaff.map(staff => {
              const isSuspended = staff.performanceScore === 0;
              const branch = branches.find(b => b.id === staff.branchId);

              return (
                <tr key={staff.id} className="hover:bg-slate-900/50 transition">
                  <td className="p-3">
                    <div className="font-bold text-white flex items-center gap-2">
                      {staff.name}
                      {isSuspended && (
                        <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold">
                          Suspended
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">ID: {staff.id}</div>
                  </td>

                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      staff.role === 'OWNER' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                      staff.role === 'MANAGER' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' :
                      staff.role === 'CASHIER' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                      staff.role === 'KITCHEN_STAFF' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' :
                      'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                    }`}>
                      {staff.role}
                    </span>
                  </td>

                  <td className="p-3 text-slate-300">
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-500" />
                      {branch ? branch.name : staff.branchId}
                    </div>
                  </td>

                  <td className="p-3 font-mono text-amber-400 font-bold">
                    ••••
                  </td>

                  <td className="p-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                      staff.activeShift ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${staff.activeShift ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                      {staff.activeShift ? 'Active Shift' : 'Off Shift'}
                    </span>
                  </td>

                  <td className="p-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleResetPin(staff)}
                        title="Reset Employee PIN"
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 text-amber-400 border border-slate-800 rounded-lg transition touch-btn"
                      >
                        <Key className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleOpenEditModal(staff)}
                        title="Edit Employee"
                        className="p-1.5 bg-slate-900 hover:bg-slate-800 text-sky-400 border border-slate-800 rounded-lg transition touch-btn"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>

                      <button
                        onClick={() => handleToggleSuspend(staff)}
                        title={isSuspended ? "Reactivate Employee" : "Suspend Employee"}
                        className={`p-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition touch-btn ${
                          isSuspended ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        {isSuspended ? <UserCheck className="w-3.5 h-3.5" /> : <UserX className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => handleDeleteStaff(staff)}
                        title="Delete Employee"
                        className="p-1.5 bg-slate-900 hover:bg-red-900/30 text-red-500 border border-slate-800 rounded-lg transition touch-btn"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile Stacked Cards (Visible on mobile) */}
      <div className="md:hidden space-y-3">
        {filteredStaff.map(staff => {
          const isSuspended = staff.performanceScore === 0;
          const branch = branches.find(b => b.id === staff.branchId);

          return (
            <div key={staff.id} className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-3">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-bold text-white text-sm flex items-center gap-1.5">
                    {staff.name}
                    {isSuspended && (
                      <span className="bg-red-500/20 text-red-400 border border-red-500/30 px-1.5 py-0.5 rounded text-[9px] font-bold">
                        Suspended
                      </span>
                    )}
                  </h4>
                  <span className="text-[10px] font-mono text-slate-500">ID: {staff.id}</span>
                </div>
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                  staff.role === 'OWNER' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                  staff.role === 'MANAGER' ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' :
                  staff.role === 'CASHIER' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                  staff.role === 'KITCHEN_STAFF' ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30' :
                  'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                }`}>
                  {staff.role}
                </span>
              </div>

              <div className="flex justify-between items-center text-xs pt-2 border-t border-slate-900">
                <span className="text-slate-400 flex items-center gap-1">
                  <Building2 className="w-3.5 h-3.5 text-slate-500" />
                  {branch ? branch.name : staff.branchId}
                </span>
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                  staff.activeShift ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${staff.activeShift ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
                  {staff.activeShift ? 'Active Shift' : 'Off Shift'}
                </span>
              </div>

              {/* Action Toolbar */}
              <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-900">
                <button
                  onClick={() => handleResetPin(staff)}
                  className="py-2.5 bg-slate-900 border border-slate-800 text-amber-400 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 touch-btn"
                >
                  <Key className="w-4 h-4" /> PIN
                </button>

                <button
                  onClick={() => handleOpenEditModal(staff)}
                  className="py-2.5 bg-slate-900 border border-slate-800 text-sky-400 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 touch-btn"
                >
                  <Edit className="w-4 h-4" /> Edit
                </button>

                <button
                  onClick={() => handleToggleSuspend(staff)}
                  className={`py-2.5 bg-slate-900 border border-slate-800 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 touch-btn ${
                    isSuspended ? 'text-emerald-400' : 'text-amber-400'
                  }`}
                >
                  {isSuspended ? <UserCheck className="w-4 h-4" /> : <UserX className="w-4 h-4" />}
                </button>

                <button
                  onClick={() => handleDeleteStaff(staff)}
                  className="py-2.5 bg-slate-900 border border-slate-800 text-red-400 font-bold rounded-xl text-xs transition flex items-center justify-center gap-1 touch-btn"
                >
                  <Trash2 className="w-4 h-4" /> Del
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add/Edit Employee Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 p-4 flex items-center justify-center">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-amber-500" />
                {editingStaff ? 'Edit Staff Member' : 'Create New Employee'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveStaff} className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-400 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Sipho Ndlovu"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Email Address</label>
                <input
                  type="email"
                  required={!editingStaff}
                  placeholder="e.g. sipho@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Password</label>
                <input
                  type="password"
                  required={!editingStaff}
                  placeholder={editingStaff ? "(Leave blank to keep unchanged)" : "Create a password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Operational Role</label>
                <select
                  value={role}
                  onChange={e => setRole(e.target.value as UserRole)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="CASHIER">Cashier (POS & Counter)</option>
                  <option value="KITCHEN_STAFF">Kitchen Staff / Chef (KDS)</option>
                  <option value="MANAGER">Manager (Supervisor)</option>
                  <option value="OWNER">Owner (Executive)</option>
                  <option value="ADMINISTRATOR">Administrator</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Assigned Branch</label>
                <select
                  value={branchId}
                  onChange={e => setBranchId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-amber-500"
                >
                  {branches.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">4-Digit Security PIN</label>
                  <input
                    type="password"
                    maxLength={4}
                    required
                    placeholder="e.g. 1234"
                    value={pin}
                    onChange={e => setPin(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-amber-400 font-mono text-center font-bold focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Confirm PIN</label>
                  <input
                    type="password"
                    maxLength={4}
                    required
                    placeholder="Re-enter PIN"
                    value={confirmPin}
                    onChange={e => setConfirmPin(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-amber-400 font-mono text-center font-bold focus:outline-none focus:border-amber-500"
                  />
                </div>
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-xl transition shadow-lg"
                >
                  {editingStaff ? 'Save Changes' : 'Save Employee'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
