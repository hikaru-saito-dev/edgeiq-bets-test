'use client';

import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Button,
  Container,
  Paper,
  CircularProgress,
  TextField,
  InputAdornment,
  IconButton,
  FormControl,
  Select,
  MenuItem,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  Tabs,
  Tab,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import BetCard from '@/components/BetCard';
import CreateBetForm from '@/components/CreateBetForm';
import { useToast } from '@/components/ToastProvider';
import { motion, AnimatePresence } from 'framer-motion';
import SearchIcon from '@mui/icons-material/Search';
import { useAccess } from '@/components/AccessProvider';
import { apiRequest } from '@/lib/apiClient';
import { alpha, useTheme } from '@mui/material/styles';

interface Bet {
  _id: string;
  eventName: string;
  startTime: string;
  odds: number;
  oddsAmerican: number;
  units: number;
  result: 'pending' | 'win' | 'loss' | 'push' | 'void';
  locked: boolean;
  createdAt: string;
  marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop' | 'Parlay';
  parlaySummary?: string;
  parlayLegs?: Array<{
    _id: string;
    eventName: string;
    startTime: string;
    oddsAmerican: number;
    marketType: 'ML' | 'Spread' | 'Total' | 'Player Prop';
    selection?: string;
    line?: number;
    overUnder?: 'Over' | 'Under';
    playerName?: string;
    statType?: string;
    odds: number;
    units: number;
    result: 'pending' | 'win' | 'loss' | 'push' | 'void';
  }>;
}

export default function BetsPage() {
  const toast = useToast();
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [hasCompanyId, setHasCompanyId] = useState<boolean | null>(null);
  const { isAuthorized, loading: accessLoading, userId, companyId } = useAccess();

  // Pagination & search
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedMarketType, setSelectedMarketType] = useState<string>('All');
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const controlBg = alpha(theme.palette.background.paper, isDark ? 0.6 : 0.98);
  const controlBorder = alpha(theme.palette.primary.main, isDark ? 0.45 : 0.25);
  const controlStyles = {
    '& .MuiOutlinedInput-root': {
      color: 'var(--app-text)',
      backgroundColor: controlBg,
      '& fieldset': { borderColor: controlBorder },
      '&:hover fieldset': { borderColor: theme.palette.primary.main },
      '&.Mui-focused fieldset': {
        borderColor: theme.palette.primary.main,
        boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.15)}`,
      },
    },
    '& .MuiInputBase-input::placeholder': {
      color: 'var(--text-muted)',
      opacity: 1,
    },
  };

  useEffect(() => {
    if (!isAuthorized) return;
    fetchBets();
    fetchUserProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, isAuthorized]);

  // Refresh companyId check when window regains focus (user might have updated profile in another tab)
  useEffect(() => {
    const handleFocus = () => {
      if (isAuthorized) {
        fetchUserProfile();
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isAuthorized]);

  const fetchUserProfile = async () => {
    if (!isAuthorized || !userId) return;
    try {
      const response = await apiRequest('/api/user', { userId, companyId });
      if (response.ok) {
        const data = await response.json();
        setHasCompanyId(!!data.user?.companyId);
      }
    } catch (error) {
      console.error('Error fetching user profile:', error);
    }
  };

  // Debounced search-as-you-type
  useEffect(() => {
    if (!isAuthorized) return;
    const handle = setTimeout(() => {
      setPage(1);
      fetchBets();
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, isAuthorized]);

  // Refetch when marketType filter changes
  useEffect(() => {
    if (!isAuthorized) return;
    setPage(1);
    fetchBets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMarketType, isAuthorized]);
  useEffect(() => {
    if (!isAuthorized) return;
    const fetchSettle = async () => {
      try {
      const response = await apiRequest('/api/bets/settle-all', {
        method: 'POST',
        userId,
        companyId,
      });
        if (!response.ok) throw new Error('Failed to settle bets');
        const data = await response.json();
        console.log(data);
      } catch (error) {
        console.error('Error settling bets:', error);
      }
    };
    fetchSettle();
    fetchBets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthorized]);

  const fetchBets = async () => {
    if (!isAuthorized) {
      setBets([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search.trim()) params.set('search', search.trim());
      if (selectedMarketType && selectedMarketType !== 'All') {
        params.set('marketType', selectedMarketType);
      }
      const response = await apiRequest(`/api/bets?${params.toString()}`, {
        userId,
        companyId,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to fetch bets' }));
        throw new Error(error.error || 'Failed to fetch bets');
      }
      const data = await response.json();
      setBets(data.bets || []);
      setTotalPages(data.totalPages || 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch bets';
      toast.showError(message);
    } finally {
      setLoading(false);
    }
  };


  if (accessLoading) {
    return (
      <Container maxWidth="lg" sx={{ py: 4 }}>
        <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight={400} gap={3}>
          <CircularProgress 
            size={60}
            thickness={4}
            sx={{ 
              color: '#22c55e',
              filter: 'drop-shadow(0 0 10px rgba(34, 197, 94, 0.5))',
            }} 
          />
          <Typography variant="h6" sx={{ color: 'var(--app-text)', fontWeight: 500 }}>
            Checking access...
          </Typography>
        </Box>
      </Container>
    );
  }

  if (!isAuthorized) {
    return (
      <Container maxWidth="md" sx={{ py: 6 }}>
        <Paper sx={{ p: 6, textAlign: 'center', borderRadius: 3 }}>
          <Typography variant="h5" gutterBottom sx={{ fontWeight: 600 }}>
            Access Restricted
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Only administrators and owners can manage bets.
          </Typography>
        </Paper>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg" sx={{ py: { xs: 2, sm: 4 }, px: { xs: 1, sm: 2 } }}>
      <motion.div
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <Box 
          display="flex" 
          flexDirection={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between" 
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          mb={2} 
          gap={2}
        >
          <Box sx={{ width: { xs: '100%', sm: 'auto' } }}>
            <Typography 
              variant="h4" 
              component="h1" 
              fontWeight={700} 
              gutterBottom
              sx={{
                background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                fontSize: { xs: '1.75rem', sm: '2.125rem' },
              }}
            >
              My Bets
            </Typography>
            <Typography 
              variant="body2" 
              color="text.secondary"
              sx={{ fontSize: { xs: '0.75rem', sm: '0.875rem' } }}
            >
              Track and manage your betting activity
            </Typography>
          </Box>
          <Button
            variant="contained"
            size="large"
            startIcon={<AddIcon />}
            onClick={() => {
              if (hasCompanyId === false) {
                setWarningOpen(true);
              } else {
                setCreateOpen(true);
              }
            }}
            sx={{ 
              width: { xs: '100%', sm: 'auto' }, 
              px: { xs: 2, sm: 3 }, 
              py: 1.5,
              background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
              boxShadow: `0 8px 32px ${alpha(theme.palette.primary.main, 0.3)}`,
              '&:hover': {
                background: `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 100%)`,
                boxShadow: `0 12px 40px ${alpha(theme.palette.primary.main, 0.4)}`,
                transform: 'translateY(-2px)',
              },
              '&:disabled': {
                background: alpha(theme.palette.primary.main, 0.3),
              },
              transition: 'all 0.3s ease',
            }}
          >
            Create Bet
          </Button>
        </Box>

        {/* Market Type Filter Tabs */}
        <Paper sx={{ mb: 3, bgcolor: 'var(--surface-bg)', backdropFilter: 'blur(6px)', borderRadius: 2, border: '1px solid var(--surface-border)' }}>
          <Tabs
            value={selectedMarketType}
            onChange={(_, newValue) => {
              setSelectedMarketType(newValue);
              setPage(1);
            }}
            variant="scrollable"
            scrollButtons="auto"
            sx={{
              '& .MuiTab-root': {
                color: 'var(--text-muted)',
                fontWeight: 500,
                textTransform: 'none',
                minHeight: 48,
                '&.Mui-selected': {
                  color: 'var(--app-text)',
                  fontWeight: 600,
                },
              },
              '& .MuiTabs-indicator': {
                backgroundColor: 'var(--app-text)',
                height: 3,
                borderRadius: '3px 3px 0 0',
              },
            }}
          >
            <Tab label="All" value="All" />
            <Tab label="Moneyline" value="ML" />
            <Tab label="Spread" value="Spread" />
            <Tab label="Total" value="Total" />
            <Tab label="Player Prop" value="Player Prop" />
            <Tab label="Parlay" value="Parlay" />
          </Tabs>
        </Paper>

        {/* Search & Pagination controls */}
        <Box display="flex" gap={2} flexWrap="wrap" mb={3}>
          <Paper sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'var(--surface-bg)', backdropFilter: 'blur(6px)', border: '1px solid var(--surface-border)', flex: { xs: '1 1 100%', sm: '0 1 auto' } }}>
            <TextField
              variant="outlined"
              size="small"
              placeholder="Search bets (team, sport, league, market, notes)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPage(1); fetchBets(); } }}
              sx={{
                minWidth: { xs: '100%', sm: 320 },
                width: { xs: '100%', sm: 'auto' },
                ...controlStyles,
              }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ color: 'var(--text-muted)' }} />
                  </InputAdornment>
                ),
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => { setPage(1); fetchBets(); }} sx={{ color: 'var(--app-text)' }}>
                      <SearchIcon />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />
          </Paper>

          <Paper sx={{ p: 1.5, display: 'flex', gap: 1.5, alignItems: 'center', bgcolor: 'var(--surface-bg)', backdropFilter: 'blur(6px)', border: '1px solid var(--surface-border)' }}>
            <Typography variant="body2" sx={{ color: 'var(--app-text)' }}>Page size</Typography>
            <FormControl size="small">
              <Select
                value={pageSize}
                onChange={(e) => { setPageSize(e.target.value as number); setPage(1); }}
                sx={{
                  minWidth: 80,
                  color: 'var(--app-text)',
                  backgroundColor: controlBg,
                  '& .MuiOutlinedInput-notchedOutline': { borderColor: controlBorder },
                  '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                  '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.primary.main },
                }}
              >
                {[10, 20, 50].map((s) => (
                  <MenuItem key={s} value={s}>{s}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Paper>
        </Box>
      </motion.div>

      {loading ? (
        <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight={400} gap={3}>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.3 }}
          >
            <CircularProgress 
              size={60}
              thickness={4}
              sx={{ 
                color: '#22c55e',
                filter: 'drop-shadow(0 0 10px rgba(34, 197, 94, 0.5))',
              }} 
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            <Typography 
              variant="h6" 
              sx={{ 
                color: 'var(--app-text)',
                fontWeight: 500,
              }}
            >
              Loading your bets...
            </Typography>
          </motion.div>
        </Box>
      ) : bets.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <Paper sx={{ p: 6, textAlign: 'center', borderRadius: 3 }}>
            <Typography variant="h6" color="text.secondary" gutterBottom>
              {search || selectedMarketType !== 'All' ? 'No bets found' : 'No bets yet'}
            </Typography>
            <Typography variant="body2" color="text.secondary" mb={3}>
              {search || selectedMarketType !== 'All' 
                ? 'Try adjusting your search or filters'
                : 'Create your first bet to start tracking your performance'}
            </Typography>
            {(!search && selectedMarketType === 'All') && (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => {
                if (hasCompanyId === false) {
                  setWarningOpen(true);
                } else {
                  setCreateOpen(true);
                }
              }}
              sx={{
                  background: `linear-gradient(135deg, ${theme.palette.primary.main} 0%, ${theme.palette.primary.dark} 100%)`,
                  boxShadow: `0 8px 32px ${alpha(theme.palette.primary.main, 0.3)}`,
                '&:hover': {
                    background: `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 100%)`,
                    boxShadow: `0 12px 40px ${alpha(theme.palette.primary.main, 0.4)}`,
                  transform: 'translateY(-2px)',
                },
                transition: 'all 0.3s ease',
              }}
            >
              Create Your First Bet
            </Button>
            )}
          </Paper>
        </motion.div>
      ) : (
        <AnimatePresence>
          <Box>
            {bets.map((bet) => (
              <motion.div
                key={bet._id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
              >
                <BetCard bet={bet} onUpdate={fetchBets} />
              </motion.div>
            ))}
          {/* Pagination */}
          {totalPages > 1 && (
            <Box display="flex" justifyContent="center" gap={1} mt={4}>
              <Button
                variant="outlined"
                disabled={page === 1}
                onClick={() => { setPage(p => Math.max(1, p - 1)); }}
              >
                Previous
              </Button>
              <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center', px: 2, color: 'text.secondary' }}>
                Page {page} / {totalPages}
              </Typography>
              <Button
                variant="outlined"
                disabled={page >= totalPages}
                onClick={() => { setPage(p => Math.min(totalPages, p + 1)); }}
              >
                Next
              </Button>
            </Box>
          )}
          </Box>
        </AnimatePresence>
      )}

      {/* Enhanced Create Bet Form */}
      <CreateBetForm
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => { setPage(1); fetchBets(); }}
      />

      {/* Warning Dialog for Missing Company ID */}
      <Dialog
        open={warningOpen}
        onClose={() => setWarningOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{
          sx: {
              bgcolor: 'var(--surface-bg)',
            backdropFilter: 'blur(20px)',
            border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
            borderRadius: 3,
            boxShadow: theme.palette.mode === 'light'
              ? '0 12px 32px rgba(34, 197, 94, 0.08)'
              : '0 12px 32px rgba(0, 0, 0, 0.45)',
          },
        }}
      >
        <DialogTitle sx={{ color: 'var(--app-text)', fontWeight: 600 }}>
          Company Access Required
        </DialogTitle>
        <DialogContent>
          <Alert 
            severity="warning" 
            sx={{ 
              mb: 2,
              backgroundColor: alpha(theme.palette.error.main, 0.1),
              border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
              '& .MuiAlert-icon': {
                color: theme.palette.error.main,
              },
            }}
          >
            You need to access this app through a Whop company to create bets.
          </Alert>
        </DialogContent>
        <DialogActions sx={{ p: 2, gap: 1 }}>
          <Button
            onClick={() => setWarningOpen(false)}
            sx={{
              color: 'var(--text-muted)',
              '&:hover': {
                backgroundColor: alpha(theme.palette.text.primary, 0.05),
              },
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setWarningOpen(false);
              window.location.href = '/profile';
            }}
            sx={{
              background: 'linear-gradient(135deg, #22c55e 0%, #059669 100%)',
              color: theme.palette.getContrastText(theme.palette.primary.main),
              '&:hover': {
                background: `linear-gradient(135deg, ${theme.palette.primary.dark} 0%, ${theme.palette.primary.main} 100%)`,
              },
            }}
          >
            Go to Profile
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
}

