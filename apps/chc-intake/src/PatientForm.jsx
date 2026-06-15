// src/PatientForm.jsx
export default function PatientForm() {
  // Enhanced input styles with focus ring for better usability
  const input = "w-full border border-gray-300 p-2.5 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all";
  const label = "block text-xs font-bold text-gray-600 mb-1.5 uppercase tracking-wide";

  return (
    <div className="bg-white p-8 rounded-xl border border-gray-200 shadow-sm h-full">
      <h2 className="text-xl font-bold mb-6 border-b pb-2 text-gray-900">1. Patient Information</h2>
      
      {/* 12-column grid ensures reliable 50/50 split on desktop */}
      <div className="grid grid-cols-12 gap-x-6 gap-y-6">
        
        {/* Left Column (col-span-6) */}
        <div className="col-span-6">
          <label className={label}>CHC Patient ID</label>
          <input className={input} placeholder="e.g. 123456789012" />
        </div>
        
        {/* Right Column (col-span-6) */}
        <div className="col-span-6">
          <label className={label}>Patient Name</label>
          <input className={input} placeholder="Full Name" />
        </div>

        <div className="col-span-6">
          <label className={label}>ABHA ID</label>
          <input className={input} placeholder="00-0000-0000-0000" />
        </div>
        <div className="col-span-6">
          <label className={label}>Age</label>
          <input type="number" className={input} placeholder="Years" />
        </div>

        <div className="col-span-6">
          <label className={label}>Nikshay ID</label>
          <input className={input} />
        </div>
        <div className="col-span-6">
          <label className={label}>Gender</label>
          <select className={`${input} bg-white`}>
            <option value="">Select Gender</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </select>
        </div>

        {/* Full-width fields */}
        <div className="col-span-12">
          <label className={label}>Consultant Name</label>
          <input className={input} />
        </div>

        <div className="col-span-12">
          <label className={label}>OPD Prescription & Notes</label>
          <textarea className={`${input} h-32 resize-none`} placeholder="Enter patient clinical notes..." />
        </div>
      </div>
    </div>
  );
}